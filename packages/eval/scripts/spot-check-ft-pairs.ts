#!/usr/bin/env bun
/**
 * Judge a random 50-pair sample of ft-pairs-v1.jsonl with gemma4 (NaN).
 *
 * gemma4 is a different model family than the generator (qwen3.6) — satisfies
 * the "different LLM than generator" rule in the spot-check spec.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const PAIRS_PATH = resolve(ROOT, "packages/eval/data/ft-pairs-v1.jsonl");
const REPORT_PATH = resolve(ROOT, "packages/eval/data/ft-pairs-v1.spot-check.md");
const NAN_BASE_URL = "https://api.nan.builders/v1";
const NAN_API_KEY = process.env.NAN_API_KEY ?? process.env.HERMES_API_KEY;
const JUDGE_MODEL = "gemma4";
const N = 50;
const SEED = 99;

if (!NAN_API_KEY) {
	const env = await Bun.file(resolve(ROOT, ".env")).text();
	for (const line of env.split("\n")) {
		const [k, v] = line.split("=");
		if (k?.trim() === "NAN_API_KEY" && v) process.env.NAN_API_KEY = v.trim();
	}
}

type Pair = {
	question: string;
	norm_id: string;
	article_id: string;
	positive_chunk: string;
};

type Verdict = "correct" | "partial" | "wrong" | "uncertain";

type Judged = Pair & { verdict: Verdict; reason: string };

const SYSTEM = `Eres un evaluador de datos de entrenamiento para un buscador legal español. Te paso un artículo legal y una pregunta. Decide si la pregunta es respondida de forma sensata por el artículo.

Devuelve JSON: {"verdict": "correct" | "partial" | "wrong" | "uncertain", "reason": "<1-2 frases en español>"}

- "correct": la pregunta es directamente respondida por el artículo
- "partial": parcialmente respondida, o requiere también otro artículo
- "wrong": el artículo no responde a la pregunta o son temas distintos
- "uncertain": pregunta o artículo confusos`;

async function judge(pair: Pair): Promise<{ verdict: Verdict; reason: string }> {
	const chunk = pair.positive_chunk.slice(0, 2500);
	const user = `${chunk}\n---\nPregunta: ${pair.question}`;
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), 60_000);
	try {
		const res = await fetch(`${NAN_BASE_URL}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				Authorization: `Bearer ${process.env.NAN_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: JUDGE_MODEL,
				messages: [
					{ role: "system", content: SYSTEM },
					{ role: "user", content: user },
				],
				temperature: 0.1,
				max_tokens: 300,
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "verdict",
						schema: {
							type: "object",
							properties: {
								verdict: {
									type: "string",
									enum: ["correct", "partial", "wrong", "uncertain"],
								},
								reason: { type: "string" },
							},
							required: ["verdict", "reason"],
							additionalProperties: false,
						},
						strict: true,
					},
				},
			}),
		});
		clearTimeout(t);
		if (!res.ok) {
			const txt = await res.text();
			return { verdict: "uncertain", reason: `HTTP ${res.status}: ${txt.slice(0, 100)}` };
		}
		// biome-ignore lint/suspicious/noExplicitAny: API response
		const data: any = await res.json();
		const content = data?.choices?.[0]?.message?.content;
		if (!content) return { verdict: "uncertain", reason: "empty response" };
		const parsed = JSON.parse(content) as { verdict: Verdict; reason: string };
		return parsed;
	} catch (err) {
		clearTimeout(t);
		return { verdict: "uncertain", reason: `error: ${(err as Error).message}` };
	}
}

// ── Load + sample ──
const lines = readFileSync(PAIRS_PATH, "utf8").trim().split("\n");
const pairs = lines.map((l) => JSON.parse(l) as Pair);

let rng = SEED;
const rand = () => {
	rng = (rng * 1664525 + 1013904223) >>> 0;
	return rng / 0xffffffff;
};
const shuffled = [...pairs].sort(() => rand() - 0.5);
const sample = shuffled.slice(0, N);
console.log(`[spot-check] judging ${sample.length} of ${pairs.length} pairs with ${JUDGE_MODEL}`);

// ── Judge in parallel batches ──
const CONCURRENCY = 4;
const judged: Judged[] = [];
for (let i = 0; i < sample.length; i += CONCURRENCY) {
	const batch = sample.slice(i, i + CONCURRENCY);
	const results = await Promise.all(batch.map(judge));
	for (let j = 0; j < batch.length; j++) {
		judged.push({ ...batch[j]!, ...results[j]! });
	}
	console.log(`[spot-check] ${judged.length}/${sample.length}`);
}

// ── Counts ──
const counts: Record<Verdict, number> = { correct: 0, partial: 0, wrong: 0, uncertain: 0 };
for (const j of judged) counts[j.verdict]++;
const passRate = ((counts.correct + counts.partial) / N) * 100;
const verdict = passRate >= 80 ? "PASS" : "FAIL";

// ── Markdown report ──
let md = `# Spot-check report — ft-pairs-v1\n\n`;
md += `- Generated: ${pairs.length} pairs by qwen3.6 (NaN)\n`;
md += `- Judged: ${N} random pairs (seed=${SEED}) by **${JUDGE_MODEL}** (NaN)\n`;
md += `- Date: ${new Date().toISOString().slice(0, 10)}\n\n`;
md += `## Verdict distribution\n\n`;
md += `| verdict | count | % |\n|---|---|---|\n`;
for (const v of ["correct", "partial", "wrong", "uncertain"] as Verdict[]) {
	md += `| ${v} | ${counts[v]} | ${((counts[v] / N) * 100).toFixed(0)}% |\n`;
}
md += `\n**Pass rate (correct + partial): ${passRate.toFixed(1)}% — ${verdict}** (gate: ≥80%)\n\n`;
md += `## Sample\n\n`;
md += `| # | norm | article | verdict | question | reason |\n|---|---|---|---|---|---|\n`;
judged.forEach((j, i) => {
	const q = j.question.replace(/\|/g, "\\|").slice(0, 120);
	const r = j.reason.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 200);
	md += `| ${i + 1} | ${j.norm_id} | ${j.article_id} | ${j.verdict} | ${q} | ${r} |\n`;
});

writeFileSync(REPORT_PATH, md);
console.log(`[spot-check] wrote ${REPORT_PATH}`);
console.log(`[spot-check] PASS RATE: ${passRate.toFixed(1)}% — ${verdict}`);
console.log(`[spot-check] counts: ${JSON.stringify(counts)}`);
