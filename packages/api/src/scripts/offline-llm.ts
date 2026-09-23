/**
 * Shared plumbing for the offline generators (article-summaries-offline.ts,
 * reform-summaries-offline.ts): JSONL I/O and a resumable, concurrent client
 * for an OpenAI-compatible endpoint (vLLM on a rented GPU). Never touches a DB.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

// Tolerates malformed lines (e.g. the last one, if generate was killed while
// appending): they are skipped and counted instead of aborting the run.
export function readJsonl<T>(path: string): { rows: T[]; badLines: number } {
	const rows: T[] = [];
	let badLines = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch {
			badLines++;
		}
	}
	return { rows, badLines };
}

export interface ChatResult {
	/** Message content with any <think> block removed. */
	text: string;
	finish?: string;
	usage?: unknown;
}

/**
 * Sends one chat request per item, `CONC` at a time, and appends one JSONL row
 * per item to `outFile`: `{ ok: true, ...toRow(item, result) }`, or
 * `{ ok: false, ...keyFields, error }` after 3 failed attempts. Items whose key
 * already has an ok row in `outFile` are skipped (resumable).
 *
 * Env: BASE (default http://127.0.0.1:8001/v1), MODEL (default qwen3.8-27b),
 * CONC (default 64); GENERATE_API_KEY is sent only if set (never the
 * OpenRouter key).
 */
export async function runGeneration<T extends object>(opts: {
	items: T[];
	outFile: string;
	/** Fields that identify an item; copied into every output row. */
	keyNames: string[];
	body: (item: T, model: string) => Record<string, unknown>;
	/** Throws to reject a reply (counts as a failed attempt). */
	toRow: (
		item: T,
		result: ChatResult,
		model: string,
	) => Record<string, unknown>;
	limit?: number;
}) {
	const base = process.env.BASE ?? "http://127.0.0.1:8001/v1";
	const model = process.env.MODEL ?? "qwen3.8-27b";
	const concurrency = Number(process.env.CONC ?? 64);
	const apiKey = process.env.GENERATE_API_KEY;
	const field = (o: object, k: string) => (o as Record<string, unknown>)[k];
	const keyFields = (o: object) =>
		Object.fromEntries(opts.keyNames.map((k) => [k, field(o, k)]));
	const keyOf = (o: object) =>
		opts.keyNames.map((k) => String(field(o, k))).join("|");

	const done = new Set<string>();
	if (existsSync(opts.outFile))
		for (const o of readJsonl<Record<string, unknown>>(opts.outFile).rows)
			if (o.ok === true) done.add(keyOf(o));
	let items = opts.items.filter((it) => !done.has(keyOf(it)));
	if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);
	console.log(`generate: ${items.length} to do, ${done.size} already done`);

	let next = 0;
	let ok = 0;
	let failed = 0;
	const started = Date.now();

	async function one(item: T) {
		let lastError = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(`${base}/chat/completions`, {
					method: "POST",
					signal: AbortSignal.timeout(600_000),
					headers: {
						"Content-Type": "application/json",
						...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					},
					body: JSON.stringify({ model, ...opts.body(item, model) }),
				});
				if (!res.ok)
					throw new Error(
						`http_${res.status}: ${(await res.text()).slice(0, 200)}`,
					);
				const data = (await res.json()) as {
					choices?: {
						message?: { content?: string };
						finish_reason?: string;
					}[];
					usage?: unknown;
				};
				const text = (data.choices?.[0]?.message?.content ?? "")
					.replace(/<think>[\s\S]*?<\/think>/g, "")
					.trim();
				const row = opts.toRow(
					item,
					{ text, finish: data.choices?.[0]?.finish_reason, usage: data.usage },
					model,
				);
				appendFileSync(
					opts.outFile,
					`${JSON.stringify({ ok: true, ...keyFields(item), ...row })}\n`,
				);
				ok++;
				return;
			} catch (e) {
				lastError = (e as Error).message;
			}
		}
		failed++;
		appendFileSync(
			opts.outFile,
			`${JSON.stringify({ ok: false, ...keyFields(item), error: lastError.slice(0, 300) })}\n`,
		);
	}

	const timer = setInterval(() => {
		const s = (Date.now() - started) / 1000;
		const rate = ok / s;
		console.log(
			`[${s.toFixed(0)}s] ok=${ok} failed=${failed} ${rate.toFixed(2)}/s eta ${((items.length - ok - failed) / Math.max(rate, 0.01) / 60).toFixed(0)} min`,
		);
	}, 30_000);
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < items.length) {
				const item = items[next++];
				if (item) await one(item);
			}
		}),
	);
	clearInterval(timer);
	console.log(`generate: done, ok=${ok} failed=${failed}`);
}
