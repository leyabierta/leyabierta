/**
 * Stage 3 — synthesis A/B on a FIXED context.
 *
 * For every synthesis question, the evidence is rebuilt from the cached
 * stage-1 pool + the chosen stage-2 rerank variant (`--context`), so every
 * model answers from exactly the same articles and the same prompt
 * (production `buildEvidence` + `synthesizeAnswer`, JSON-schema mode).
 *
 * Usage:
 *   bun .../synth.ts --models google/gemini-2.5-flash-lite,openai/gpt-6-luna \
 *     --context llm_google_gemini-2.5-flash-lite [--max-usd 0.05]
 */

import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SYNTHESIS_QUESTIONS } from "./queries.ts";
import { chat, OUT_DIR, REPO_ROOT, spent } from "./shared.ts";

const {
	buildEvidence,
	synthesizeAnswer,
	verifyCitations,
	INLINE_CITE_PATTERN,
} = await import("../../../src/services/rag/synthesis.ts");
type Article =
	import("../../../src/services/rag/retrieval.ts").RetrievedArticle;

const args = process.argv.slice(2);
const argVal = (k: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : undefined;
};
const MODELS = (argVal("--models") ?? "google/gemini-2.5-flash-lite").split(
	",",
);
const CONTEXT = argVal("--context") ?? "none";
const MAX_USD = Number(argVal("--max-usd") ?? "0.06");
const LIMIT = Number(argVal("--limit") ?? "0");
const DATA_DIR = process.env.DATA_DIR ?? join(REPO_ROOT, "data");
const db = new Database(join(DATA_DIR, "leyabierta.db"), { readonly: true });

/** Per-model request extras (reasoning off / minimal: citizen-facing latency). */
export const SYNTH_EXTRA: Record<string, Record<string, unknown>> = {
	// Many ZDR hosts at very different prices: route to the cheapest.
	"deepseek/deepseek-v4.1-flash": {
		reasoning: { enabled: false },
		provider: { sort: "price" },
	},
	"openai/gpt-6-luna": { reasoning: { effort: "minimal" } },
};

const stage1 = readFileSync(
	join(OUT_DIR, "stage1-google_gemini-2.5-flash-lite.jsonl"),
	"utf8",
)
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l)) as Array<{
	id: string;
	question: string;
	type: string;
	reason?: string;
	useTemporal?: boolean;
	pool?: Article[];
}>;
const ctx = JSON.parse(
	readFileSync(join(OUT_DIR, `stage2-${CONTEXT}.json`), "utf8"),
) as Array<{ id: string; keys: string[] }>;
const ctxById = new Map(ctx.map((c) => [c.id, c.keys]));

const outPath = join(OUT_DIR, `stage3-${CONTEXT}.jsonl`);
const done = new Set(
	existsSync(outPath)
		? readFileSync(outPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const o = JSON.parse(l);
					return `${o.model}|${o.id}`;
				})
		: [],
);

// Transport with per-model extras + ledger (via shared.chat).
function llmFnFor(model: string) {
	// biome-ignore lint/suspicious/noExplicitAny: SynthesisLlmFn shape
	return async (_key: string, opts: any) => {
		const body: Record<string, unknown> = {
			model,
			messages: opts.messages,
			temperature: opts.temperature ?? 0,
			max_tokens: opts.maxTokens ?? 2500,
			response_format: {
				type: "json_schema",
				json_schema: {
					name: opts.jsonSchema.name,
					strict: true,
					schema: opts.jsonSchema.schema,
				},
			},
			plugins: [{ id: "response-healing" }],
			...SYNTH_EXTRA[model],
		};
		let last = "";
		for (let attempt = 0; attempt < 4; attempt++) {
			if (attempt > 0)
				await new Promise((res) => setTimeout(res, 4000 * attempt));
			const r = await chat(`synth:${CONTEXT}`, body);
			const text = r.json?.choices?.[0]?.message?.content ?? "";
			if (r.status === 200 && text) {
				try {
					const clean = text
						.trim()
						.replace(/^```(?:json)?\n?/, "")
						.replace(/\n?```$/, "");
					return {
						data: JSON.parse(clean),
						cost: r.cost,
						tokensIn: r.json?.usage?.prompt_tokens ?? 0,
						tokensOut: r.json?.usage?.completion_tokens ?? 0,
						_ms: r.ms,
						_provider: r.json?.provider,
					};
				} catch {
					last = `json_parse: ${text.slice(0, 150)}`;
				}
			} else last = `${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`;
		}
		throw new Error(last);
	};
}

for (const model of MODELS) {
	const startSpent = spent();
	for (const sq of LIMIT
		? SYNTHESIS_QUESTIONS.slice(0, LIMIT)
		: SYNTHESIS_QUESTIONS) {
		const row = stage1.find((r) => r.question === sq.question);
		if (!row) {
			console.warn(`missing stage1 row for: ${sq.question}`);
			continue;
		}
		if (done.has(`${model}|${row.id}`)) continue;
		if (spent() - startSpent > MAX_USD) {
			console.log(`[${model}] per-model cap reached`);
			break;
		}
		if (row.type !== "ready" || !row.pool) {
			appendFileSync(
				outPath,
				`${JSON.stringify({ model, id: row.id, question: row.question, kind: sq.kind, early: row.reason })}\n`,
			);
			continue;
		}
		const keys = ctxById.get(row.id) ?? [];
		const byKey = new Map(row.pool.map((a) => [`${a.normId}:${a.blockId}`, a]));
		const articles = keys.map((k) => byKey.get(k)).filter(Boolean) as Article[];
		const { evidenceText, systemPrompt } = buildEvidence({
			db,
			articles,
			useTemporal: !!row.useTemporal,
			streaming: false,
		});
		const t0 = performance.now();
		let rec: Record<string, unknown>;
		try {
			const s = await synthesizeAnswer({
				apiKey: "unused",
				question: row.question,
				evidenceText,
				systemPrompt,
				model,
				llmFn: llmFnFor(model),
			});
			const ms = performance.now() - t0;
			const valid = verifyCitations(s.citations, articles);
			const inline = [...s.answer.matchAll(INLINE_CITE_PATTERN)].map((m) => ({
				normId: m[1]!,
				articleTitle: m[2]!.trim(),
			}));
			const inlineValid = verifyCitations(inline, articles);
			rec = {
				model,
				id: row.id,
				question: row.question,
				kind: sq.kind,
				answer: s.answer,
				tldr: s.tldr,
				declined: s.declined,
				citations: s.citations,
				citeRaw: s.citations.length,
				citeVerified: valid.filter((c) => c.verified).length,
				citeInEvidence: valid.length,
				inlineRaw: inline.length,
				inlineVerified: inlineValid.filter((c) => c.verified).length,
				inlineInEvidence: inlineValid.length,
				cost: s.cost,
				tokensIn: s.tokensIn,
				tokensOut: s.tokensOut,
				ms: Math.round(ms),
				contextKeys: keys,
			};
		} catch (err) {
			rec = {
				model,
				id: row.id,
				question: row.question,
				kind: sq.kind,
				error: err instanceof Error ? err.message : String(err),
				ms: Math.round(performance.now() - t0),
			};
		}
		appendFileSync(outPath, `${JSON.stringify(rec)}\n`);
		console.log(
			`[${model}] ${row.id} ${rec.error ? `ERROR ${rec.error}` : `${rec.ms}ms $${(rec.cost as number).toFixed(5)} cites ${rec.citeVerified}/${rec.citeRaw}`} spent=$${spent().toFixed(4)}`,
		);
	}
}
db.close();
