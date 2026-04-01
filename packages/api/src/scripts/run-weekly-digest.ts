/**
 * Unified weekly digest pipeline: generate → AI score → regenerate email HTML.
 *
 * Orchestrates all 3 phases in one script, suitable for a cronjob.
 * All digest data is stored in SQLite (digests table).
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/run-weekly-digest.ts --week 2026-W13
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/run-weekly-digest.ts --week 2026-W13 --profile autonomos
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/run-weekly-digest.ts  # current week
 *
 * Flags:
 *   --week YYYY-WNN    ISO week (default: current week)
 *   --profile ID       Only one profile (default: all 8)
 *   --model ID         OpenRouter model (default: google/gemini-3.1-flash-lite-preview)
 *   --dry-run          Skip AI scoring, only run phase 1
 *   --skip-generate    Skip phase 1 (use existing DB data)
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { PROFILES } from "../data/profiles.ts";
import { DbService } from "../services/db.ts";

// ── CLI ──

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

function getCurrentWeek(): string {
	const now = new Date();
	const jan4 = new Date(now.getFullYear(), 0, 4);
	const dayOfYear = Math.floor(
		(now.getTime() - jan4.getTime()) / 86400000 + (jan4.getDay() || 7),
	);
	const weekNum = Math.ceil(dayOfYear / 7);
	return `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

const week = getArg("week") ?? getCurrentWeek();
const profileFilter = getArg("profile");
const modelId = getArg("model") ?? "google/gemini-3.1-flash-lite-preview";
const dryRun = hasFlag("dry-run");
const skipGenerate = hasFlag("skip-generate");

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey && !dryRun) {
	console.error(
		"Set OPENROUTER_API_KEY env variable (or use --dry-run to skip AI)",
	);
	process.exit(1);
}

const SCRIPT_DIR = import.meta.dir;
const MONOREPO_ROOT = join(SCRIPT_DIR, "..", "..", "..", "..");
const WORKSPACE_ROOT = join(MONOREPO_ROOT, "..");

const dbPath =
	process.env.DB_PATH ?? join(WORKSPACE_ROOT, "data", "leyabierta.db");

console.log(`\n═══ Weekly Digest Pipeline ═══`);
console.log(`Week: ${week}`);
console.log(`Model: ${modelId}`);
console.log(`Profile: ${profileFilter ?? "all"}`);
console.log(`Mode: ${dryRun ? "dry-run (no AI)" : "full"}`);
console.log("");

// ── Phase 1: Generate raw digests into DB ──

if (!skipGenerate) {
	console.log("── Phase 1: Generate digests into DB ──");
	const generateScript = join(
		MONOREPO_ROOT,
		"packages/api/src/scripts/generate-digest.ts",
	);
	const generateArgs = ["run", generateScript, "--week", week];
	if (profileFilter) generateArgs.push("--profile", profileFilter);

	const generateProc = Bun.spawnSync(["bun", ...generateArgs], {
		cwd: WORKSPACE_ROOT,
		env: { ...process.env, DB_PATH: dbPath },
		stdout: "inherit",
		stderr: "inherit",
	});

	if (generateProc.exitCode !== 0) {
		console.error("Phase 1 failed");
		process.exit(1);
	}
	console.log("");
}

// ── Phase 2: AI relevance scoring ──

if (dryRun) {
	console.log("── Phase 2: Skipped (dry-run) ──\n");
} else {
	console.log("── Phase 2: AI relevance scoring ──");

	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	createSchema(db);
	const dbService = new DbService(db);

	const profilesToScore = profileFilter
		? PROFILES.filter((p) => p.id === profileFilter)
		: PROFILES;

	let totalCost = 0;
	let totalTokensIn = 0;
	let totalTokensOut = 0;

	for (const profile of profilesToScore) {
		const digest = dbService.getDigest(profile.id, week);
		if (!digest) {
			console.log(
				`  ${profile.icon} ${profile.name}: no digest in DB, skipping`,
			);
			continue;
		}

		let digestData: { reforms: Reform[] };
		try {
			digestData = JSON.parse(digest.data);
		} catch {
			console.log(
				`  ${profile.icon} ${profile.name}: malformed JSON, skipping`,
			);
			continue;
		}

		if (!digestData.reforms || digestData.reforms.length === 0) {
			console.log(`  ${profile.icon} ${profile.name}: 0 reforms, skipping`);
			continue;
		}

		// Already scored?
		const alreadyScored = digestData.reforms.some((r) => r.relevant !== null);
		if (alreadyScored) {
			const relevant = digestData.reforms.filter(
				(r) => r.relevant === true,
			).length;
			console.log(
				`  ${profile.icon} ${profile.name}: already scored (${relevant} relevant), skipping`,
			);
			continue;
		}

		const result = await scoreDigest(digestData.reforms, profile, digest);
		if (result) {
			// Write updated data back to DB
			dbService.upsertDigest(
				profile.id,
				week,
				digest.jurisdiction,
				result.summary,
				digest.generated_at,
				JSON.stringify({ reforms: result.reforms }),
			);
			totalCost += result.cost;
			totalTokensIn += result.tokensIn;
			totalTokensOut += result.tokensOut;
		}
	}

	console.log(`\n  ── Totals ──`);
	console.log(
		`  Profiles: ${profilesToScore.length} | Tokens: ${totalTokensIn} in, ${totalTokensOut} out | Cost: $${totalCost.toFixed(6)}`,
	);
	console.log("");

	db.close();
}

// ── Phase 3: Generate email HTML (optional) ──

console.log("── Phase 3: Generate email HTML ──");
const emailScript = join(
	MONOREPO_ROOT,
	"packages/api/src/scripts/generate-digest.ts",
);
const emailRunArgs = ["run", emailScript, "--week", week, "--from-db"];
if (profileFilter) emailRunArgs.push("--profile", profileFilter);

const htmlProc = Bun.spawnSync(["bun", ...emailRunArgs], {
	cwd: WORKSPACE_ROOT,
	env: { ...process.env, DB_PATH: dbPath },
	stdout: "inherit",
	stderr: "inherit",
});

if (htmlProc.exitCode !== 0) {
	console.error("Phase 3 failed (non-critical)");
}

console.log("\n═══ Done ═══\n");

// ── AI Scoring function ──

interface Reform {
	id: string;
	title: string;
	rank: string;
	date: string;
	source_id: string;
	relevant: boolean | null;
	te_afecta_porque: string;
	headline: string;
	summary: string;
	confidence: string;
	affected_blocks: Array<{
		block_id: string;
		title: string;
		change_type: string;
		previous_text: string;
		current_text: string;
	}>;
}

async function scoreDigest(
	reforms: Reform[],
	profile: (typeof PROFILES)[number],
	_digest: { jurisdiction: string },
): Promise<{
	summary: string;
	reforms: Reform[];
	cost: number;
	tokensIn: number;
	tokensOut: number;
} | null> {
	// Build compact prompt
	const reformsList = reforms
		.map((r) => {
			const blocks = r.affected_blocks
				.map((b) => {
					if (b.change_type === "new") {
						return `  [NEW] ${b.title}: ${b.current_text.slice(0, 300)}`;
					}
					const prev = b.previous_text.slice(0, 200);
					const curr = b.current_text.slice(0, 200);
					return `  [MOD] ${b.title}:\n    antes: ${prev}\n    ahora: ${curr}`;
				})
				.join("\n");
			return `- [${r.id}] ${r.title} (${r.rank}, ${r.date})${blocks ? `\n${blocks}` : " (sin bloques afectados)"}`;
		})
		.join("\n\n");

	const systemPrompt = `Eres un asistente que clasifica cambios legislativos por relevancia para un perfil ciudadano concreto.

Responde SOLO con JSON. Cada reforma tiene:
- "id": identificador exacto
- "relevant": true o false
- "headline": titulo corto ciudadano (max 10 palabras). Solo si relevant=true, si no ""
- "summary": 2-3 frases sobre que cambio y por que importa. Usa "tu", "tu negocio". Solo si relevant=true, si no ""
- "te_afecta_porque": una frase de por que le afecta. Solo si relevant=true, si no ""
- "confidence": "high" o "low". Solo si relevant=true, si no ""

Reglas:
- ESTRICTO con relevancia. Solo relevant=true si afecta DIRECTAMENTE al perfil.
- NO inventes cambios. Si no ves el diff, usa "se actualizan", "se modifican".
- Español correcto con acentos.`;

	const userPrompt = `PERFIL: ${profile.name}
PERSONA: ${profile.persona}

REFORMAS (${week}):

${reformsList}

Responde:
{
  "digest_summary": "1-2 frases resumiendo la semana para este perfil",
  "reforms": [{"id":"...","relevant":true/false,"headline":"...","summary":"...","te_afecta_porque":"...","confidence":"..."}]
}`;

	const startTime = Date.now();

	const response = await fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://leyabierta.es",
				"X-Title": "Ley Abierta Digest",
			},
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				temperature: 0.2,
				max_tokens: 4000,
				response_format: { type: "json_object" },
			}),
		},
	);

	const elapsed = Date.now() - startTime;

	if (!response.ok) {
		const errorText = await response.text();
		console.error(
			`  ${profile.icon} ${profile.name}: API error ${response.status}: ${errorText}`,
		);
		return null;
	}

	const data = await response.json();
	const usage = data.usage ?? {};
	const resultText = data.choices?.[0]?.message?.content ?? "";
	const cost = usage.cost ?? 0;

	// Parse JSON
	let cleanText = resultText.trim();
	if (cleanText.startsWith("```")) {
		cleanText = cleanText
			.replace(/^```(?:json)?\n?/, "")
			.replace(/\n?```$/, "");
	}

	let parsed: {
		digest_summary?: string;
		reforms?: Array<{
			id: string;
			relevant: boolean;
			headline: string;
			summary: string;
			te_afecta_porque: string;
			confidence: string;
		}>;
	};

	try {
		parsed = JSON.parse(cleanText);
	} catch {
		console.error(`  ${profile.icon} ${profile.name}: JSON parse failed`);
		console.error(`    ${cleanText.slice(0, 200)}`);
		return null;
	}

	const aiReforms = parsed.reforms ?? [];
	const relevant = aiReforms.filter((r) => r.relevant);

	// Merge AI results into reforms
	for (const reform of reforms) {
		const aiResult = aiReforms.find((r) => r.id === reform.id);
		if (aiResult) {
			reform.relevant = aiResult.relevant;
			reform.headline = aiResult.headline ?? "";
			reform.summary = aiResult.summary ?? "";
			reform.te_afecta_porque = aiResult.te_afecta_porque ?? "";
			reform.confidence = aiResult.confidence ?? "";
		} else {
			reform.relevant = false;
			reform.headline = "";
			reform.summary = "";
			reform.te_afecta_porque = "";
			reform.confidence = "";
		}
	}

	console.log(
		`  ${profile.icon} ${profile.name}: ${relevant.length}/${reforms.length} relevant | ${(elapsed / 1000).toFixed(1)}s | $${cost.toFixed(6)}`,
	);

	return {
		summary: parsed.digest_summary ?? "",
		reforms,
		cost,
		tokensIn: usage.prompt_tokens ?? 0,
		tokensOut: usage.completion_tokens ?? 0,
	};
}
