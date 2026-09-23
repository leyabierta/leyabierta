/**
 * Stage 2 — apply rerank variants to the cached stage-1 pools and score
 * norm-level retrieval against the gold set.
 *
 * Variants (all ZDR-compatible on OpenRouter):
 *   none                     — fused order (prod de facto: Cohere 404s under ZDR)
 *   llm:<chat model>         — listwise LLM rerank (src/services/rag/llm-rerank.ts)
 *   xenc:qwen/qwen3-reranker-8b — cross-encoder via OpenRouter /rerank
 *
 * The post-rerank step mirrors runRetrievalCore exactly: keep the reranked
 * keys in rerank order, then applyLegalHierarchyBoost(articles, pool, db).
 *
 * Usage:
 *   bun .../rerank.ts --variants none,llm:google/gemini-2.5-flash-lite [--limit N] [--max-usd 0.1]
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
	firstGoldRank,
	guard,
	OR_KEY,
	OUT_DIR,
	REPO_ROOT,
	record,
	rerankApi,
	spent,
} from "./shared.ts";

const { llmRerank } = await import("../../../src/services/rag/llm-rerank.ts");
const { applyLegalHierarchyBoost, TOP_K } = await import(
	"../../../src/services/rag/retrieval.ts"
);
const { describeNormScope } = await import(
	"../../../src/services/rag/analyzer.ts"
);
const { resolveJurisdiction } = await import(
	"../../../src/services/rag/jurisdiction.ts"
);
type Article =
	import("../../../src/services/rag/retrieval.ts").RetrievedArticle;

const args = process.argv.slice(2);
const argVal = (k: string) => {
	const i = args.indexOf(k);
	return i >= 0 ? args[i + 1] : undefined;
};
const VARIANTS = (argVal("--variants") ?? "none").split(",");
const LIMIT = Number(argVal("--limit") ?? "0");
const MAX_USD = Number(argVal("--max-usd") ?? "0.1");
const STAGE1 =
	argVal("--stage1") ??
	join(OUT_DIR, "stage1-google_gemini-2.5-flash-lite.jsonl");
const DATA_DIR = process.env.DATA_DIR ?? join(REPO_ROOT, "data");
const db = new Database(join(DATA_DIR, "leyabierta.db"), { readonly: true });

/** Per-model extra body: disable/limit reasoning so rerank stays fast. */
const EXTRA: Record<string, Record<string, unknown>> = {
	"deepseek/deepseek-v4.1-flash": { reasoning: { enabled: false } },
	"openai/gpt-6-luna": { reasoning: { effort: "minimal" } },
	"z-ai/glm-5.3-flash": { reasoning: { enabled: false } },
};

interface Stage1Row {
	id: string;
	question: string;
	gold: string[];
	source: string;
	type: "ready" | "early";
	noRerankKeys?: string[];
	pool?: Article[];
}

const rows = (await Bun.file(STAGE1).text())
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l)) as Stage1Row[];
const work = LIMIT ? rows.slice(0, LIMIT) : rows;

function candidatesOf(pool: Article[]) {
	return pool.map((a) => ({
		key: `${a.normId}:${a.blockId}`,
		title: `${a.blockTitle} — ${describeNormScope(a.rank, resolveJurisdiction(a.sourceUrl, a.normId))}: ${a.normTitle}`,
		text: a.text,
	}));
}

function finalize(pool: Article[], rankedKeys: string[]): string[] {
	const order = new Map(rankedKeys.map((k, i) => [k, i]));
	const articles = pool
		.filter((a) => order.has(`${a.normId}:${a.blockId}`))
		.sort(
			(a, b) =>
				(order.get(`${a.normId}:${a.blockId}`) ?? 999) -
				(order.get(`${b.normId}:${b.blockId}`) ?? 999),
		);
	return applyLegalHierarchyBoost(articles, pool, db).map(
		(a) => `${a.normId}:${a.blockId}`,
	);
}

async function runVariant(variant: string) {
	const out: Array<Record<string, unknown>> = [];
	const startSpent = spent();
	for (const [i, r] of work.entries()) {
		if (r.type !== "ready" || !r.pool) {
			out.push({ id: r.id, keys: [], ms: 0, cost: 0, backend: "early" });
			continue;
		}
		if (spent() - startSpent > MAX_USD) {
			console.log(`[${variant}] per-variant cap $${MAX_USD} reached at ${i}`);
			break;
		}
		guard();
		const pool = r.pool;
		let keys: string[];
		let ms = 0;
		let cost = 0;
		let backend = variant;
		if (variant === "none") {
			keys = r.noRerankKeys ?? [];
		} else if (variant.startsWith("llm:")) {
			const model = variant.slice(4);
			const t0 = performance.now();
			const res = await llmRerank(
				OR_KEY,
				r.question,
				candidatesOf(pool),
				TOP_K,
				{
					model,
					extraBody: EXTRA[model],
					label: variant,
				},
			);
			ms = performance.now() - t0;
			cost = res.cost;
			backend = res.backend;
			record("rerank", model, cost, { ms: Math.round(ms), backend });
			keys = finalize(
				pool,
				res.results.map((x) => x.key),
			);
		} else if (variant.startsWith("xenc:")) {
			const model = variant.slice(5);
			const cands = candidatesOf(pool);
			const res = await rerankApi("rerank", {
				model,
				query: r.question,
				documents: cands.map((c) => `${c.title}\n\n${c.text.slice(0, 600)}`),
				top_n: TOP_K,
			});
			ms = res.ms;
			cost = res.cost;
			if (res.status !== 200) {
				backend = `${variant}-${res.status}`;
				keys = r.noRerankKeys ?? [];
			} else {
				const ranked = (res.json.results as Array<{ index: number }>).map(
					(x) => cands[x.index]!.key,
				);
				keys = finalize(pool, ranked);
			}
		} else throw new Error(`unknown variant ${variant}`);
		out.push({ id: r.id, keys, ms: Math.round(ms), cost, backend });
		if ((i + 1) % 10 === 0)
			console.log(
				`[${variant}] ${i + 1}/${work.length} spent(total)=$${spent().toFixed(4)}`,
			);
	}
	await Bun.write(
		join(OUT_DIR, `stage2-${variant.replace(/[^a-z0-9.-]+/gi, "_")}.json`),
		JSON.stringify(out),
	);
	return out;
}

function pct(n: number, d: number) {
	return d ? ((100 * n) / d).toFixed(1) : "-";
}
function quantile(xs: number[], q: number) {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

const table: string[] = [
	"| Variant | n | Hit@1 | Hit@5 | Hit@15 | MRR@15 | Pool ceiling | p50 ms | p95 ms | $/q | fallbacks |",
	"|---|---|---|---|---|---|---|---|---|---|---|",
];
for (const v of VARIANTS) {
	const res = await runVariant(v);
	const byId = new Map(res.map((x) => [x.id as string, x]));
	const scored = work.filter((r) => r.gold.length > 0 && byId.has(r.id));
	let h1 = 0,
		h5 = 0,
		h15 = 0,
		mrr = 0,
		ceil = 0;
	for (const r of scored) {
		const keys = (byId.get(r.id)!.keys as string[]) ?? [];
		const norms = keys.map((k) => k.split(":")[0]!);
		const fr = firstGoldRank(norms, r.gold);
		if (fr === 1) h1++;
		if (fr && fr <= 5) h5++;
		if (fr && fr <= 15) h15++;
		if (fr) mrr += 1 / fr;
		if (r.pool?.some((a) => r.gold.includes(a.normId))) ceil++;
	}
	const called = res.filter((x) => (x.ms as number) > 0);
	const lat = called.map((x) => x.ms as number);
	const costs = called.map((x) => x.cost as number);
	const fallbacks = res.filter((x) =>
		String(x.backend).match(/failed|passthrough|-\d{3}$/),
	).length;
	table.push(
		`| ${v} | ${scored.length} | ${pct(h1, scored.length)} | ${pct(h5, scored.length)} | ${pct(h15, scored.length)} | ${(mrr / (scored.length || 1)).toFixed(3)} | ${pct(ceil, scored.length)} | ${Math.round(quantile(lat, 0.5))} | ${Math.round(quantile(lat, 0.95))} | ${costs.length ? (costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(5) : "0"} | ${fallbacks} |`,
	);
	console.log(table.join("\n"));
}
await Bun.write(
	join(OUT_DIR, `stage2-table-${Date.now()}.md`),
	`${table.join("\n")}\n`,
);
console.log(`total spent (this ledger) $${spent().toFixed(4)}`);
db.close();
