#!/usr/bin/env bun
/**
 * CLI: run retrieval eval against a JSONL (unified QAEntry) or legacy JSON
 * (gold-eval-v1) dataset.
 *
 * Usage:
 *   bun run packages/eval/src/run-eval.ts \
 *     --in <enriched.jsonl | gold-eval-v1.json> \
 *     --retriever rag-direct|api-http \
 *     --out <results.jsonl> \
 *     [--limit N] [--top-k 10] [--concurrency 4] \
 *     [--summary <summary.json>] \
 *     [--api-url http://localhost:3000]   # for api-http only
 *
 * Input format detection:
 *   - .jsonl  → unified QAEntry JSONL (one JSON object per line)
 *   - .json   → auto-detects legacy gold-eval-v1 shape ({ results: [...] })
 *               or unified QAEntry array ([ {...}, {...} ])
 *
 * Legacy gold-eval-v1 shape:
 *   { id, question, expectedNorms: string[], category, style, topic, source, confidence }
 *   → adapted to QAEntry with source="dgt-generales", domain="tax",
 *     boe_a_ids = expectedNorms
 *
 * Entries with empty boe_a_ids are skipped (no ground truth).
 *
 * Config note (rag-direct):
 *   Model: qwen3-nan (EMBEDDING_MODEL_KEY default)
 *   Retriever: hybrid BM25 + vector KNN + RRF fusion + Qwen3.6 LLM reranker
 *   TOP_K pipeline: 15 articles (deduplicated to norm level for R@K)
 *   Results are reproducible given the same DB + vectors-int8.bin snapshot.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AggregateMetrics, type EvalResult, runEval } from "./harness.ts";
import type { QAEntry } from "./qa-schema.ts";

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
	let inPath: string | undefined;
	let outPath: string | undefined;
	let summaryPath: string | undefined;
	let retriever: "rag-direct" | "api-http" | "rag-gemini-legacy" = "rag-direct";
	let limit: number | undefined;
	let topK = 10;
	let concurrency = 4;
	let apiUrl = "http://localhost:3000";
	// BM25-only mode: skip vector index loading (lower memory, lower quality)
	let bm25Only = process.env.RAG_BM25_ONLY === "1";
	let successorsPath: string | undefined;
	let successorsScope: "total" | "all" = "total"; // only count total derogations by default
	let dryRun = false;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		switch (a) {
			case "--in":
				inPath = argv[++i];
				break;
			case "--out":
				outPath = argv[++i];
				break;
			case "--summary":
				summaryPath = argv[++i];
				break;
			case "--retriever":
				retriever = argv[++i] as
					| "rag-direct"
					| "api-http"
					| "rag-gemini-legacy";
				break;
			case "--limit":
				limit = Number(argv[++i]);
				break;
			case "--top-k":
				topK = Number(argv[++i]);
				break;
			case "--concurrency":
				concurrency = Number(argv[++i]);
				break;
			case "--api-url":
				apiUrl = argv[++i]!;
				break;
			case "--bm25-only":
				bm25Only = true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--successors-map":
				successorsPath = argv[++i];
				break;
			case "--successors-scope":
				successorsScope = argv[++i] as "total" | "all";
				break;
		}
	}

	return {
		inPath,
		outPath,
		summaryPath,
		retriever,
		limit,
		topK,
		concurrency,
		apiUrl,
		bm25Only,
		successorsPath,
		successorsScope,
		dryRun,
	};
}

// ── Successor map loading ─────────────────────────────────────────────────────

/**
 * Loads the norm-successors flat JSONL into a Map<old_id, Set<successor_ids>>.
 * Includes hard-coded overrides for known BOE data gaps where the relation
 * exists in reality but is not recorded in BOE analisis cross-references.
 */
async function loadSuccessorsMap(
	path: string,
	scope: "total" | "all",
): Promise<Map<string, Set<string>>> {
	const map = new Map<string, Set<string>>();
	const add = (old: string, neu: string) => {
		if (!map.has(old)) map.set(old, new Set());
		map.get(old)!.add(neu);
	};

	const text = await Bun.file(path).text();
	let kept = 0;
	let total = 0;
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		total++;
		const o = JSON.parse(t) as {
			old_norm_id: string;
			new_norm_id: string;
			scope?: string;
		};
		if (scope === "total" && o.scope !== "total") continue;
		add(o.old_norm_id, o.new_norm_id);
		kept++;
	}

	// Manual overrides for known BOE data gaps (see Phase 1B map validation):
	// - RDL 4/2004 (TR-LIS) was progressively derogated article-by-article 2006-2014,
	//   never with a single full-derogation clause in BOE. Ley 27/2014 IS is the
	//   substantive successor.
	add("BOE-A-2004-4456", "BOE-A-2014-12328");
	// - Ley 30/1992 → Ley 40/2015 (LRJSP): BOE records 39/2015 as the derogator
	//   but 40/2015 is the companion law covering juridical-regime scope. Both
	//   together replaced 30/1992 in 2016.
	add("BOE-A-1992-26318", "BOE-A-2015-10566");

	console.log(
		`[successors-map] Loaded ${kept}/${total} pairs (scope=${scope}), ${map.size} unique old norms`,
	);
	return map;
}

// ── Input adapters ────────────────────────────────────────────────────────────

/**
 * Legacy gold-eval-v1 entry shape.
 * The `source` field is an object (not a QASource string), so we map it.
 * `expectedNorms` uses camelCase, not `boe_a_ids`.
 *
 * Mismatch notes:
 * - `source` is an object { origin, numConsulta, ... } — we map origin to the
 *   nearest QASource enum value ("dgt-generales" for dgt-regex/dgt-llm origins).
 * - No `answer` field — we use a placeholder (harness only needs question + norms).
 * - `confidence` (1-3 scale) has no direct QAEntry equivalent — dropped.
 * - `topic` ("Tributario") maps to domain "tax".
 */
interface GoldEvalEntry {
	id: string;
	question: string;
	expectedNorms: string[];
	category: string;
	style: string;
	topic: string;
	source: {
		origin: string;
		numConsulta?: string;
		organo?: string;
		[key: string]: unknown;
	};
	confidence: number;
}

function mapTopicToDomain(
	topic: string,
): QAEntry["metadata"]["domain"] | undefined {
	const t = topic.toLowerCase();
	if (t.includes("tribut") || t.includes("fiscal") || t.includes("impuest"))
		return "tax";
	if (t.includes("famil") || t.includes("divorcio")) return "family";
	if (t.includes("asilo") || t.includes("refugio")) return "asylum";
	if (t.includes("constituc")) return "constitutional";
	if (t.includes("parlamint") || t.includes("parlam")) return "parliament";
	return "admin";
}

function mapOriginToSource(origin: string): QAEntry["source"] {
	if (origin.includes("vinculante")) return "dgt-vinculantes";
	return "dgt-generales";
}

function adaptGoldEvalEntry(e: GoldEvalEntry): QAEntry {
	return {
		id: e.id,
		source: mapOriginToSource(e.source.origin),
		question: e.question,
		// No full answer in gold-eval-v1 — use empty string (harness doesn't need it)
		answer: "(not available in gold-eval-v1)",
		norms: {
			citations_raw: [],
			boe_a_ids: e.expectedNorms,
		},
		metadata: {
			domain: mapTopicToDomain(e.topic),
			jurisdiction: "es",
			organo: e.source.organo,
		},
	};
}

/**
 * Detect format from file extension + content shape.
 * Returns an async generator of QAEntry objects.
 */
async function* loadEntries(
	filePath: string,
	limit?: number,
): AsyncIterable<QAEntry> {
	const text = await Bun.file(filePath).text();
	const isJsonl = filePath.endsWith(".jsonl");

	let count = 0;

	if (isJsonl) {
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (limit !== undefined && count >= limit) break;
			const obj = JSON.parse(trimmed) as QAEntry;
			yield obj;
			count++;
		}
		return;
	}

	// JSON file — detect shape
	const parsed = JSON.parse(text) as unknown;

	if (
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		"results" in (parsed as object)
	) {
		// Legacy gold-eval-v1: { results: GoldEvalEntry[] }
		const entries = (parsed as { results: GoldEvalEntry[] }).results;
		for (const e of entries) {
			if (limit !== undefined && count >= limit) break;
			yield adaptGoldEvalEntry(e);
			count++;
		}
		return;
	}

	if (Array.isArray(parsed)) {
		// Unified QAEntry array
		for (const e of parsed as QAEntry[]) {
			if (limit !== undefined && count >= limit) break;
			yield e;
			count++;
		}
		return;
	}

	throw new Error(
		`Unknown JSON format in ${filePath}. Expected { results: [] } or QAEntry[].`,
	);
}

// ── Output helpers ────────────────────────────────────────────────────────────

function appendResultLine(outPath: string, result: EvalResult): void {
	appendFileSync(outPath, `${JSON.stringify(result)}\n`, "utf8");
}

function formatMetrics(m: AggregateMetrics): string {
	const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
	return `R@1=${pct(m.r1)}  R@5=${pct(m.r5)}  R@10=${pct(m.r10)}  MRR=${m.mrr.toFixed(3)}  N=${m.n}`;
}

function buildMarkdownReport(
	aggregate: AggregateMetrics,
	inPath: string,
	retriever: string,
	topK: number,
	elapsedMs: number,
	bm25Only = false,
): string {
	const lines: string[] = [];
	const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

	lines.push(`## Eval run — ${new Date().toISOString()}`);
	lines.push("");
	lines.push(`- Input: \`${inPath}\``);
	lines.push(`- Retriever: \`${retriever}\``);
	lines.push(`- Top-K: ${topK}`);
	if (retriever === "rag-gemini-legacy") {
		lines.push(
			"- Config: gemini-embedding-2 (OpenRouter), hybrid BM25+vector KNN, RRF fusion, Cohere rerank-4-pro",
		);
	} else if (retriever === "rag-direct" && bm25Only) {
		lines.push("- Config: BM25-only (vector index skipped — low memory mode)");
	} else if (retriever === "rag-direct") {
		lines.push(
			"- Config: qwen3-nan embeddings, hybrid BM25+vector KNN, RRF fusion, Qwen3.6 reranker",
		);
	} else {
		lines.push(
			"- Config: api-http (citation-level recall only, not full retrieval pool)",
		);
	}
	lines.push(`- Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`);
	lines.push("");
	lines.push("### Aggregate");
	lines.push("");
	lines.push("| Metric | Value |");
	lines.push("|--------|-------|");
	lines.push(`| N | ${aggregate.n} |`);
	lines.push(`| R@1 | ${pct(aggregate.r1)} |`);
	lines.push(`| R@5 | ${pct(aggregate.r5)} |`);
	lines.push(`| R@10 | ${pct(aggregate.r10)} |`);
	lines.push(`| MRR | ${aggregate.mrr.toFixed(3)} |`);

	if (aggregate.per_source && Object.keys(aggregate.per_source).length > 0) {
		lines.push("");
		lines.push("### By source");
		lines.push("");
		lines.push("| Source | N | R@1 | R@5 | R@10 | MRR |");
		lines.push("|--------|---|-----|-----|------|-----|");
		for (const [src, m] of Object.entries(aggregate.per_source)) {
			lines.push(
				`| ${src} | ${m.n} | ${pct(m.r1)} | ${pct(m.r5)} | ${pct(m.r10)} | ${m.mrr.toFixed(3)} |`,
			);
		}
	}

	if (aggregate.per_domain && Object.keys(aggregate.per_domain).length > 0) {
		lines.push("");
		lines.push("### By domain");
		lines.push("");
		lines.push("| Domain | N | R@1 | R@5 | R@10 | MRR |");
		lines.push("|--------|---|-----|-----|------|-----|");
		for (const [dom, m] of Object.entries(aggregate.per_domain)) {
			lines.push(
				`| ${dom} | ${m.n} | ${pct(m.r1)} | ${pct(m.r5)} | ${pct(m.r10)} | ${m.mrr.toFixed(3)} |`,
			);
		}
	}

	return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (!args.inPath) {
		console.error(
			"Usage: bun run packages/eval/src/run-eval.ts --in <path> --retriever rag-direct|api-http|rag-gemini-legacy [options]",
		);
		process.exit(1);
	}

	console.log(`[eval] Loading entries from ${args.inPath}`);

	// Build retrieve function
	let retrieve: (q: string) => Promise<import("./harness.ts").EvalCandidate[]>;

	if (args.retriever === "api-http") {
		const { makeApiHttpRetriever } = await import("./retrievers/api-http.ts");
		retrieve = makeApiHttpRetriever({ baseUrl: args.apiUrl });
		console.log(`[eval] Retriever: api-http → ${args.apiUrl}`);
	} else if (args.retriever === "rag-gemini-legacy") {
		// Gemini embedding + Cohere rerank — A/B comparison stack (pre-Phase-6).
		// Imported lazily so the common Qwen path avoids loading this module.
		const { initGeminiLegacy, makeGeminiLegacyRetriever } = await import(
			"./retrievers/rag-gemini-legacy.ts"
		);
		const repoRoot = join(import.meta.dir, "../../../");
		await initGeminiLegacy({ repoRoot });
		retrieve = makeGeminiLegacyRetriever(args.topK);
		console.log(
			"[eval] Retriever: rag-gemini-legacy (gemini-embedding-2 + Cohere rerank)",
		);
	} else {
		const { initRagDirect, makeRagDirectRetriever } = await import(
			"./retrievers/rag-direct.ts"
		);
		const repoRoot = join(import.meta.dir, "../../../");
		await initRagDirect({ repoRoot, bm25Only: args.bm25Only });
		retrieve = makeRagDirectRetriever(args.topK);
		const mode = args.bm25Only ? "bm25-only" : "hybrid";
		console.log(`[eval] Retriever: rag-direct (${mode})`);
	}

	// Dry-run: validate the stack initialises and exit without processing queries.
	if (args.dryRun) {
		console.log(
			`[eval] --dry-run: retriever initialised successfully (${args.retriever}). No queries processed.`,
		);
		if (args.retriever === "rag-direct") {
			const { closeRagDirect } = await import("./retrievers/rag-direct.ts");
			closeRagDirect();
		} else if (args.retriever === "rag-gemini-legacy") {
			const { closeGeminiLegacy } = await import(
				"./retrievers/rag-gemini-legacy.ts"
			);
			closeGeminiLegacy();
		}
		process.exit(0);
	}

	// Truncate output file if it exists
	if (args.outPath) {
		writeFileSync(args.outPath, "", "utf8");
		console.log(`[eval] Streaming results → ${args.outPath}`);
	}

	const startedAt = Date.now();
	let processed = 0;
	let runningR1 = 0;
	let runningR5 = 0;
	let runningR10 = 0;
	let runningMrr = 0;
	let skipped = 0;

	const entries = loadEntries(args.inPath, args.limit);

	const successorsMap = args.successorsPath
		? await loadSuccessorsMap(args.successorsPath, args.successorsScope)
		: undefined;

	const { aggregate } = await runEval({
		entries,
		topK: args.topK,
		retrieve,
		concurrency: args.concurrency,
		successorsMap,
		onResult: (r) => {
			processed++;
			if (args.outPath) {
				appendResultLine(args.outPath, r);
			}
			// Running hit-rate from results in flight; the outer `aggregate`
			// from destructuring is in TDZ here (returned only after runEval
			// resolves), so accumulate manually.
			runningR1 += r.metrics.r1;
			runningR5 += r.metrics.r5;
			runningR10 += r.metrics.r10;
			runningMrr += r.metrics.mrr;
			if (processed % 50 === 0) {
				const n = processed;
				process.stdout.write(
					`\r  [${n}] R@1=${((runningR1 / n) * 100).toFixed(0)}% R@5=${((runningR5 / n) * 100).toFixed(0)}% R@10=${((runningR10 / n) * 100).toFixed(0)}% MRR=${(runningMrr / n).toFixed(3)}     `,
				);
			}
		},
	});

	process.stdout.write("\n");

	// Count skipped (entries with no expected norms)
	skipped = (args.limit ?? 9999) - processed; // approximate

	const elapsedMs = Date.now() - startedAt;

	console.log(
		`\n[eval] Done: ${processed} evaluated, elapsed ${(elapsedMs / 1000).toFixed(1)}s`,
	);
	console.log(`[eval] ${formatMetrics(aggregate)}`);

	// Write summary JSON
	const summaryPath =
		args.summaryPath ??
		(args.outPath ? args.outPath.replace(/\.jsonl$/, "-summary.json") : null);

	const retrieverConfig =
		args.retriever === "rag-gemini-legacy"
			? {
					embeddingModel: "gemini-embedding-2",
					retrieval: "hybrid-bm25-vector-rrf",
					reranker: "cohere-rerank-4-pro",
					pipeline_top_k: 15,
					bm25Only: false,
				}
			: {
					embeddingModel: args.bm25Only ? "none (bm25-only)" : "qwen3-nan",
					retrieval: args.bm25Only ? "bm25-only" : "hybrid-bm25-vector-rrf",
					reranker: args.bm25Only ? "none (bm25-only)" : "qwen3.6-nan",
					pipeline_top_k: 15,
					bm25Only: args.bm25Only,
				};

	const summary = {
		timestamp: new Date().toISOString(),
		input: args.inPath,
		retriever: args.retriever,
		topK: args.topK,
		concurrency: args.concurrency,
		limit: args.limit,
		config: retrieverConfig,
		elapsedMs,
		processed,
		skipped,
		aggregate,
	};

	if (summaryPath) {
		writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
		console.log(`[eval] Summary → ${summaryPath}`);
	}

	// Markdown report to stdout
	const report = buildMarkdownReport(
		aggregate,
		args.inPath,
		args.retriever,
		args.topK,
		elapsedMs,
		args.bm25Only,
	);
	console.log(`\n${report}`);

	// Clean up
	if (args.retriever === "rag-direct") {
		const { closeRagDirect } = await import("./retrievers/rag-direct.ts");
		closeRagDirect();
	} else if (args.retriever === "rag-gemini-legacy") {
		const { closeGeminiLegacy } = await import(
			"./retrievers/rag-gemini-legacy.ts"
		);
		closeGeminiLegacy();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
