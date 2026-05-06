/**
 * Latency benchmark for nan.builders qwen3-embedding API.
 *
 * Goal: characterize the API in isolation — no retries, no concurrency, no
 * resume — so we know:
 *   1. Cold-start latency (first request after idle).
 *   2. Per-batch latency curve as batch_size grows from 1 to 32.
 *   3. Whether long inputs exceed CF's 100s timeout deterministically.
 *   4. Output dimensions (sanity check 4096).
 *
 * Output is structured enough to paste into a provider bug report.
 *
 * Usage:
 *   NAN_API_KEY=sk-... bun packages/api/research/ab/nan-latency-bench.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildCorpusPlan } from "./corpus.ts";

const NAN_URL = "https://api.nan.builders/v1/embeddings";
const MODEL = "qwen3-embedding";
const apiKey = process.env.NAN_API_KEY;
if (!apiKey) {
	console.error("NAN_API_KEY required");
	process.exit(1);
}

interface BenchResult {
	label: string;
	batchSize: number;
	avgInputChars: number;
	avgInputTokensEst: number;
	status: number | "timeout" | "error";
	wallMs: number;
	dims: number | null;
	usage?: Record<string, unknown>;
	errMsg?: string;
}

async function callOnce(
	texts: string[],
	timeoutMs: number,
): Promise<
	Omit<
		BenchResult,
		"label" | "batchSize" | "avgInputChars" | "avgInputTokensEst"
	>
> {
	const start = Date.now();
	try {
		const res = await fetch(NAN_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				input: texts,
				encoding_format: "float",
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const wallMs = Date.now() - start;
		if (!res.ok) {
			const errText = await res.text();
			return {
				status: res.status,
				wallMs,
				dims: null,
				errMsg: errText.slice(0, 300),
			};
		}
		const json = (await res.json()) as {
			data?: Array<{ embedding: number[] }>;
			usage?: Record<string, unknown>;
		};
		const dims = json.data?.[0]?.embedding?.length ?? null;
		return { status: res.status, wallMs, dims, usage: json.usage };
	} catch (err) {
		const wallMs = Date.now() - start;
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: msg.includes("timed out") ? "timeout" : "error",
			wallMs,
			dims: null,
			errMsg: msg.slice(0, 200),
		};
	}
}

const repoRoot = join(import.meta.dir, "../../../../");
const dbPath = join(repoRoot, "data", "leyabierta.db");
const db = new Database(dbPath, { readonly: true });
const plan = await buildCorpusPlan(db);
db.close();

// Sample real chunks from the corpus to use as input.
const realChunks = plan.blocks.slice(0, 200).map((b) => b.text.slice(0, 24000));
const sortedByLen = [...realChunks].sort((a, b) => a.length - b.length);
const shortChunks = sortedByLen.slice(0, 32);
const medianChunks = sortedByLen.slice(
	Math.floor(sortedByLen.length / 2) - 16,
	Math.floor(sortedByLen.length / 2) + 16,
);
const longChunks = sortedByLen.slice(-32);

console.log("\n=== nan.builders qwen3-embedding latency benchmark ===\n");
console.log(`Endpoint: ${NAN_URL}`);
console.log(`Model: ${MODEL}`);
console.log(`Sample chunks (real legal text):`);
console.log(`  short  avg=${avgLen(shortChunks)} chars`);
console.log(`  median avg=${avgLen(medianChunks)} chars`);
console.log(`  long   avg=${avgLen(longChunks)} chars`);

function avgLen(arr: string[]): number {
	return Math.round(arr.reduce((s, t) => s + t.length, 0) / arr.length);
}

const results: BenchResult[] = [];

async function run(
	label: string,
	batch: string[],
	timeoutMs: number,
): Promise<void> {
	const r = await callOnce(batch, timeoutMs);
	const out: BenchResult = {
		label,
		batchSize: batch.length,
		avgInputChars: avgLen(batch),
		avgInputTokensEst: Math.round(avgLen(batch) / 4),
		...r,
	};
	results.push(out);
	const dimStr = out.dims !== null ? `${out.dims}d` : "—";
	const usageStr = out.usage
		? ` tokens=${(out.usage as { total_tokens?: number }).total_tokens ?? "?"}`
		: "";
	console.log(
		`[${label}] batch=${out.batchSize} chars=${out.avgInputChars} → ${out.status} in ${out.wallMs}ms ${dimStr}${usageStr}${out.errMsg ? ` err="${out.errMsg.slice(0, 100)}"` : ""}`,
	);
}

// Phase 1: warmup + dim sanity (single short input)
console.log("\n--- Phase 1: warmup ---");
await run("warmup", [shortChunks[0]!], 60_000);
await run("warmup-2", [shortChunks[1]!], 60_000);

// Phase 2: batch_size sweep on MEDIAN-length inputs (representative)
console.log("\n--- Phase 2: batch_size sweep (median-length inputs) ---");
for (const bs of [1, 2, 4, 8, 16, 24, 32]) {
	await run(`med-bs${bs}`, medianChunks.slice(0, bs), 120_000);
	await new Promise((r) => setTimeout(r, 1000));
}

// Phase 3: same sweep on LONG inputs (legal text often runs long)
console.log("\n--- Phase 3: batch_size sweep (long inputs) ---");
for (const bs of [1, 4, 8, 16, 32]) {
	await run(`long-bs${bs}`, longChunks.slice(0, bs), 150_000);
	await new Promise((r) => setTimeout(r, 1000));
}

// Phase 4: short inputs at full batch (pure capacity probe)
console.log("\n--- Phase 4: short inputs at batch=32 (pure capacity) ---");
await run("short-bs32", shortChunks.slice(0, 32), 120_000);

// Summary
console.log("\n=== SUMMARY ===");
console.log(
	"label,batchSize,avgInputChars,estTokens,status,wallMs,msPerEmb,dims",
);
for (const r of results) {
	const perEmb = r.dims !== null ? Math.round(r.wallMs / r.batchSize) : "—";
	console.log(
		`${r.label},${r.batchSize},${r.avgInputChars},${r.avgInputTokensEst},${r.status},${r.wallMs},${perEmb},${r.dims ?? "—"}`,
	);
}

// Failure analysis
const failures = results.filter((r) => r.status !== 200);
if (failures.length > 0) {
	console.log("\n=== FAILURES ===");
	for (const f of failures) {
		console.log(
			`${f.label} (batch=${f.batchSize}, chars=${f.avgInputChars}): ${f.status} after ${f.wallMs}ms — ${f.errMsg ?? ""}`,
		);
	}
}

const successes = results.filter((r) => r.status === 200 && r.dims !== null);
if (successes.length > 0) {
	const dimsSet = new Set(successes.map((s) => s.dims));
	console.log(
		`\nDimensions returned: ${[...dimsSet].join(", ")} (expected 4096)`,
	);
}
