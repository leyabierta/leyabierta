#!/usr/bin/env bun
/**
 * Generate synthetic Q→article training pairs for fine-tuning Qwen embeddings.
 *
 * Sampling:
 *   - Random norm from ../leyes/<jurisdiction>/BOE-A-*.md, excluding heldout-norms.json
 *   - Random article within that norm, skipping dispositions (dt, da, df, dd prefixes)
 *     and subchunk ids (anything with __ separator)
 *   - Min article body length: 200 chars (skip stubs)
 *
 * Generation: Qwen 3.6 via NaN, citizen-style Spanish question.
 *
 * Output: streaming JSONL append, one line per pair.
 */

import { readdirSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const LEYES_DIR = resolve(ROOT, "../leyes");
const HELDOUT_PATH = resolve(ROOT, "packages/eval/data/heldout-norms.json");
const OUT_PATH = resolve(ROOT, "packages/eval/data/ft-pairs-v1.jsonl");

const NAN_BASE_URL = "https://api.nan.builders/v1";
const NAN_API_KEY = process.env.NAN_API_KEY ?? process.env.HERMES_API_KEY;
const GENERATOR_MODEL = "qwen3.6";

const TARGET_PAIRS = Number.parseInt(process.argv[2] ?? "1000", 10);
const PROMPT_VERSION = process.argv[3] ?? "v1";
const CONCURRENCY = 4;

if (!NAN_API_KEY) {
	console.error("NAN_API_KEY (or HERMES_API_KEY) not set");
	process.exit(1);
}

// ── Load .env if NAN_API_KEY came from there ──
async function loadEnv(): Promise<void> {
	const envFile = Bun.file(resolve(ROOT, ".env"));
	if (!(await envFile.exists())) return;
	const text = await envFile.text();
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		const value = trimmed.slice(eq + 1).trim();
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

// ── Heldout norms ──
function loadHeldout(): Set<string> {
	const raw = JSON.parse(readFileSync(HELDOUT_PATH, "utf8")) as {
		norm_ids?: string[];
		heldout_norm_ids?: string[];
	};
	const ids = raw.norm_ids ?? raw.heldout_norm_ids ?? [];
	return new Set(ids);
}

// ── Already-generated pairs (resume support) ──
function loadExisting(): { count: number; seenNormIds: Set<string> } {
	if (!existsSync(OUT_PATH)) return { count: 0, seenNormIds: new Set() };
	const text = readFileSync(OUT_PATH, "utf8");
	const seen = new Set<string>();
	let count = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as { norm_id: string };
			seen.add(obj.norm_id);
			count++;
		} catch {
			// ignore malformed line
		}
	}
	return { count, seenNormIds: seen };
}

// ── Norm enumeration ──
type NormRef = { id: string; jurisdiction: string; path: string };

function enumerateNorms(heldout: Set<string>): NormRef[] {
	const norms: NormRef[] = [];
	for (const juris of readdirSync(LEYES_DIR)) {
		const jurisDir = resolve(LEYES_DIR, juris);
		try {
			for (const f of readdirSync(jurisDir)) {
				if (!f.endsWith(".md")) continue;
				const id = f.slice(0, -3);
				if (heldout.has(id)) continue;
				norms.push({ id, jurisdiction: juris, path: resolve(jurisDir, f) });
			}
		} catch {
			// not a directory
		}
	}
	return norms;
}

// ── Article extraction ──
type Article = { id: string; title: string; body: string };

function extractArticles(markdown: string): Article[] {
	const lines = markdown.split("\n");
	const heads: Array<{ start: number; id: string; title: string }> = [];
	const headRe =
		/^#{2,6}\s*Art[íi]culo\s+([0-9]+(?:\s+(?:bis|ter|quater))?)\.?\s*(.*)$/i;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]?.match(headRe);
		if (m) {
			heads.push({
				start: i,
				id: `a${m[1]?.replace(/\s+/g, "").toLowerCase()}`,
				title: m[2] ?? "",
			});
		}
	}
	const out: Article[] = [];
	for (let i = 0; i < heads.length; i++) {
		const h = heads[i]!;
		const end = heads[i + 1]?.start ?? lines.length;
		const body = lines.slice(h.start, end).join("\n").trim();
		out.push({ id: h.id, title: h.title, body });
	}
	return out;
}

// ── Random utilities (deterministic per run for reproducibility) ──
let rng = 42 ^ Date.now();
function rand(): number {
	rng = (rng * 1664525 + 1013904223) >>> 0;
	return rng / 0xffffffff;
}
function pick<T>(arr: T[]): T {
	return arr[Math.floor(rand() * arr.length)]!;
}

// ── Qwen 3.6 prompt ──
const SYSTEM_PROMPT_V1 = `Eres un experto en derecho español que ayuda a generar datos de entrenamiento para un buscador legal ciudadano. Tu tarea: dado el texto de un artículo legal, escribir UNA pregunta en español, en lenguaje ciudadano (no jurídico), que un ciudadano podría hacer y cuya respuesta esté directamente en este artículo.

REGLAS:
- La pregunta DEBE poder responderse leyendo el artículo. No hagas preguntas ambiguas o demasiado generales.
- Lenguaje ciudadano: nada de "sujeto pasivo", "hecho imponible", "ámbito objetivo". Sí: "quién paga", "qué se considera", "cuándo aplica".
- Una sola pregunta. Frase completa terminada en "?".
- No menciones el número del artículo ni el nombre de la ley.
- No respondas — solo formula la pregunta.

Devuelve JSON con esta forma exacta: {"question": "..."}`;

const SYSTEM_PROMPTS: Record<string, string> = { v1: SYSTEM_PROMPT_V1 };

async function generateQuestion(
	article: Article,
	promptVersion: string,
): Promise<string | null> {
	const sys = SYSTEM_PROMPTS[promptVersion];
	if (!sys) throw new Error(`Unknown prompt version: ${promptVersion}`);
	const body = article.body.length > 4000 ? article.body.slice(0, 4000) : article.body;
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(`${NAN_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${NAN_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: GENERATOR_MODEL,
				messages: [
					{ role: "system", content: sys },
					{ role: "user", content: body },
				],
				temperature: 0.7,
				max_tokens: 200,
				chat_template_kwargs: { enable_thinking: false },
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "question",
						schema: {
							type: "object",
							properties: { question: { type: "string" } },
							required: ["question"],
							additionalProperties: false,
						},
						strict: true,
					},
				},
			}),
		});
		clearTimeout(t);
		if (!res.ok) {
			console.error(`[qwen] HTTP ${res.status}`);
			return null;
		}
		// biome-ignore lint/suspicious/noExplicitAny: API response shape
		const data: any = await res.json();
		const content = data?.choices?.[0]?.message?.content;
		if (!content) return null;
		const parsed = JSON.parse(content) as { question?: string };
		const q = parsed.question?.trim();
		if (!q || !q.endsWith("?")) return null;
		return q;
	} catch (err) {
		clearTimeout(t);
		console.error(`[qwen] error: ${(err as Error).message}`);
		return null;
	}
}

// ── Main ──
async function main(): Promise<void> {
	await loadEnv();
	console.log(`[ft-gen] Target: ${TARGET_PAIRS} pairs, prompt=${PROMPT_VERSION}`);

	const heldout = loadHeldout();
	console.log(`[ft-gen] Heldout norms: ${heldout.size}`);

	const norms = enumerateNorms(heldout);
	console.log(`[ft-gen] Candidate norms: ${norms.length}`);

	const existing = loadExisting();
	let count = existing.count;
	console.log(`[ft-gen] Already generated: ${count}`);

	let consecutiveErrors = 0;
	const startedAt = Date.now();

	async function generateOne(): Promise<boolean> {
		const norm = pick(norms);
		if (heldout.has(norm.id)) return false; // belt-and-suspenders
		let md: string;
		try {
			md = readFileSync(norm.path, "utf8");
		} catch {
			return false;
		}
		const articles = extractArticles(md).filter(
			(a) => !a.id.startsWith("dt") &&
				!a.id.startsWith("da") &&
				!a.id.startsWith("df") &&
				!a.id.startsWith("dd") &&
				a.body.length >= 200,
		);
		if (articles.length === 0) return false;
		const article = pick(articles);
		const question = await generateQuestion(article, PROMPT_VERSION);
		if (!question) return false;
		const line = JSON.stringify({
			question,
			norm_id: norm.id,
			article_id: article.id,
			positive_chunk: article.body,
			generator_model: GENERATOR_MODEL,
			generated_at: new Date().toISOString(),
			prompt_version: PROMPT_VERSION,
		});
		appendFileSync(OUT_PATH, line + "\n");
		return true;
	}

	while (count < TARGET_PAIRS) {
		const batch = Array.from({ length: CONCURRENCY }, () => generateOne());
		const results = await Promise.all(batch);
		const successes = results.filter(Boolean).length;
		count += successes;
		if (successes === 0) {
			consecutiveErrors += CONCURRENCY;
			if (consecutiveErrors >= 10) {
				console.error(`[ft-gen] Stop: ${consecutiveErrors} consecutive failures`);
				process.exit(1);
			}
		} else {
			consecutiveErrors = 0;
		}
		if (count % 100 === 0 || count >= TARGET_PAIRS) {
			const elapsedMin = (Date.now() - startedAt) / 60_000;
			const rate = count > existing.count ? (count - existing.count) / elapsedMin : 0;
			console.log(
				`[ft-gen] ${count}/${TARGET_PAIRS} pairs (${rate.toFixed(1)} pairs/min)`,
			);
			if (elapsedMin > 30 && rate < 10) {
				console.error(`[ft-gen] Stop: rate ${rate.toFixed(1)}/min < 10/min sustained`);
				process.exit(1);
			}
		}
	}

	const totalMin = (Date.now() - startedAt) / 60_000;
	console.log(
		`[ft-gen] Done: ${count} pairs in ${totalMin.toFixed(1)} min (${OUT_PATH})`,
	);
}

await main();
