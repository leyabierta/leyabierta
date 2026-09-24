/**
 * Batch API reprocessing of reform summaries (reform-batch.ts): request body
 * identical to the daily cron, custom_id ↔ reform mapping, collection into the
 * `generate` row format, DELETE after collecting, resumption. No network: a
 * fake fetch plays the OpenRouter Batch API.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BATCH_MODEL,
	BATCH_STORED_MODEL,
	type BatchState,
	batchPayload,
	batchRequestBody,
	collectOnce,
	type ExportRow,
	type FetchFn,
	loadState,
	planBatches,
	saveState,
	submitBatches,
} from "../scripts/reform-batch.ts";
import {
	promptHash,
	validateGeneratedReform,
} from "../scripts/reform-summary-import.ts";
import {
	PROMPT_VERSION,
	REFORM_JSON_SCHEMA,
	REFORM_MAX_TOKENS,
	REFORM_SYSTEM_PROMPT,
	REFORM_TEMPERATURE,
	reformReasoning,
} from "../scripts/reform-summary-prompt.ts";
import { callOpenRouter } from "../services/openrouter.ts";

const SUMMARY = {
	headline: "La ley cambia el plazo para pedir la ayuda",
	summary: "El plazo para solicitar la ayuda pasa de un mes a dos meses.",
	importance: "normal",
	reform_type: "modification",
};

function exportRow(n: number, over: Partial<ExportRow> = {}): ExportRow {
	const user = `Reforma número ${n}`;
	return {
		norm_id: `BOE-A-2020-${n}`,
		source_id: `BOE-A-2021-${n}`,
		reform_date: "2021-06-01",
		user,
		input_hash: promptHash({ system: REFORM_SYSTEM_PROMPT, user }),
		prompt_version: PROMPT_VERSION,
		...over,
	};
}

function completion(content: string, finish = "stop") {
	return {
		status_code: 200,
		body: {
			choices: [{ message: { content }, finish_reason: finish }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		},
	};
}

/** A fake Batch API: records calls, answers from `batches`. */
function fakeApi(batches: Record<string, Record<string, unknown>>) {
	const calls: { method: string; url: string; body?: string }[] = [];
	let next = 0;
	const fetchFn: FetchFn = async (url, init) => {
		const method = init?.method ?? "GET";
		calls.push({ method, url, body: init?.body as string | undefined });
		if (method === "POST") {
			const id = `batch-${next++}`;
			return Response.json({ id, status: "validating" }, { status: 202 });
		}
		const id = url.split("/").pop() ?? "";
		if (method === "DELETE") {
			if (!batches[id]) return new Response("", { status: 404 });
			delete batches[id];
			return Response.json({ deletion: { openrouter: "deleted" } });
		}
		const b = batches[id];
		return b ? Response.json(b) : new Response("", { status: 404 });
	};
	return { calls, fetchFn };
}

/** Marks chunk `i` as submitted under batch `id`. */
function submitted(state: BatchState, i: number, id: string) {
	const chunk = state.batches[i];
	if (chunk) chunk.id = id;
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "reform-batch-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const readRows = (path: string) =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("request body", () => {
	test("is what the cron sends for openai/*, minus routing fields and model", async () => {
		const realFetch = globalThis.fetch;
		const sent: Record<string, unknown>[] = [];
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body)));
			return Response.json({
				choices: [{ message: { content: JSON.stringify(SUMMARY) } }],
				usage: {},
			});
		}) as unknown as typeof fetch;
		try {
			// The exact options of generate-reform-summaries.ts.
			await callOpenRouter("k", {
				model: BATCH_STORED_MODEL,
				messages: [
					{ role: "system", content: REFORM_SYSTEM_PROMPT },
					{ role: "user", content: "texto" },
				],
				temperature: REFORM_TEMPERATURE,
				maxTokens: REFORM_MAX_TOKENS,
				jsonSchema: REFORM_JSON_SCHEMA,
				reasoning: reformReasoning(BATCH_STORED_MODEL),
			});
		} finally {
			globalThis.fetch = realFetch;
		}
		const { model, provider, plugins, ...cron } = sent[0] ?? {};
		expect(model).toBe(BATCH_STORED_MODEL);
		expect(provider).toBeDefined(); // ZDR routing: sync only
		expect(plugins).toBeDefined();
		expect(batchRequestBody("texto")).toEqual(cron);
	});

	test("reasoning minimal, strict schema, no provider field", () => {
		const body = batchRequestBody("x");
		expect(body.reasoning).toEqual({ effort: "minimal" });
		expect(body).not.toHaveProperty("provider");
		expect(body).not.toHaveProperty("model");
		expect(
			(body.response_format as { json_schema: { strict: boolean } }).json_schema
				.strict,
		).toBe(true);
	});

	test("payload puts endpoint and model before requests", () => {
		const json = batchPayload([{ custom_id: "r0", body: { a: 1 } }]);
		expect(Object.keys(JSON.parse(json))).toEqual([
			"endpoint",
			"model",
			"requests",
		]);
		expect(json.indexOf('"endpoint"')).toBeLessThan(json.indexOf('"requests"'));
		expect(JSON.parse(json).model).toBe(BATCH_MODEL);
		expect(json).not.toContain('"provider"');
	});
});

describe("planBatches", () => {
	test("custom_id is the export line; chunks respect the size", () => {
		const rows = [0, 1, 2, 3, 4].map((n) => exportRow(n));
		const { state } = planBatches("e.jsonl", rows, { chunk: 2 });
		expect(state.batches.map((b) => b.custom_ids)).toEqual([
			["r0", "r1"],
			["r2", "r3"],
			["r4"],
		]);
		expect(state.items.r3).toMatchObject({
			norm_id: "BOE-A-2020-3",
			source_id: "BOE-A-2021-3",
			reform_date: "2021-06-01",
		});
	});

	test("refuses stale prompts, duplicates and done keys", () => {
		const rows = [
			exportRow(0),
			exportRow(1, { prompt_version: "2026-09-23.4" }),
			exportRow(2, { input_hash: "0000000000000000" }),
			exportRow(0),
			exportRow(3),
		];
		const { state, refused } = planBatches("e.jsonl", rows, {
			skipKeys: new Set(["BOE-A-2020-3|BOE-A-2021-3|2021-06-01"]),
		});
		expect(Object.keys(state.items)).toEqual(["r0"]);
		expect(refused).toEqual({
			prompt_version_changed: 1,
			prompt_hash_mismatch: 1,
			duplicate_in_export: 1,
			already_done: 1,
		});
	});

	test("chunk above 2000 is rejected", () => {
		expect(() => planBatches("e.jsonl", [], { chunk: 2001 })).toThrow();
	});
});

describe("submit and collect", () => {
	test("submits each chunk once and resumes after a failure", async () => {
		const rows = [0, 1, 2].map((n) => exportRow(n));
		const statePath = join(dir, "state.json");
		const { state } = planBatches("e.jsonl", rows, { chunk: 1 });
		saveState(statePath, state);
		const users = new Map(rows.map((r, i) => [`r${i}`, r.user]));
		const api = fakeApi({});
		let posts = 0;
		const flaky: FetchFn = async (url, init) => {
			if (init?.method === "POST" && ++posts === 2)
				return new Response("boom", { status: 500 });
			return api.fetchFn(url, init);
		};
		await expect(
			submitBatches(
				{ apiKey: "k", fetch: flaky },
				statePath,
				state,
				(id) => users.get(id) ?? "",
				() => {},
			),
		).rejects.toThrow("HTTP 500");
		expect(loadState(statePath).batches.map((b) => b.id)).toEqual([
			"batch-0",
			undefined,
			undefined,
		]);
		const resumed = loadState(statePath);
		const n = await submitBatches(
			{ apiKey: "k", fetch: api.fetchFn },
			statePath,
			resumed,
			(id) => users.get(id) ?? "",
			() => {},
		);
		expect(n).toBe(2);
		const posted = api.calls.filter((c) => c.method === "POST");
		// batch-0 once (first run) + two chunks on resume
		expect(posted).toHaveLength(3);
		const sent = JSON.parse(posted[1]?.body ?? "{}");
		expect(sent.requests[0].custom_id).toBe("r1");
		expect(sent.requests[0].body.messages[1].content).toBe("Reforma número 1");
	});

	test("refuses a state planned with another prompt version", async () => {
		const { state } = planBatches("e.jsonl", [exportRow(0)]);
		state.prompt_version = "old";
		await expect(
			submitBatches({ apiKey: "k" }, join(dir, "s.json"), state, () => ""),
		).rejects.toThrow("export again");
	});

	test("collect writes generate-format rows, fails the bad ones, DELETEs", async () => {
		const rows = [0, 1, 2, 3, 4].map((n) => exportRow(n));
		const statePath = join(dir, "state.json");
		const outFile = join(dir, "out.jsonl");
		const { state } = planBatches("e.jsonl", rows, { chunk: 5 });
		submitted(state, 0, "b1");
		saveState(statePath, state);
		const api = fakeApi({
			b1: {
				id: "b1",
				status: "completed",
				usage: { cost: 0.01 },
				results: [
					{ custom_id: "r0", response: completion(JSON.stringify(SUMMARY)) },
					{ custom_id: "r1", response: completion("{no json") },
					{
						custom_id: "r2",
						response: completion(JSON.stringify(SUMMARY), "length"),
					},
					{
						custom_id: "r3",
						response: null,
						error: { code: "server_error", message: "upstream" },
					},
					// r4 missing from results
					{ custom_id: "zzz", response: completion("{}") },
				],
			},
		});
		const res = await collectOnce(
			{ apiKey: "k", fetch: api.fetchFn },
			statePath,
			state,
			outFile,
			() => {},
		);
		expect(res).toEqual({ pending: 0, written: 5, ok: 1 });
		const out = readRows(outFile);
		const ok = out[0] ?? {};
		expect(Object.keys(ok)).toEqual([
			"ok",
			"norm_id",
			"source_id",
			"reform_date",
			"input_hash",
			"prompt_version",
			"model",
			"result",
			"finish",
			"usage",
		]);
		expect(ok).toMatchObject({
			ok: true,
			norm_id: "BOE-A-2020-0",
			model: BATCH_STORED_MODEL,
			prompt_version: PROMPT_VERSION,
			result: SUMMARY,
		});
		expect(validateGeneratedReform(ok).ok).toBe(true);
		expect(out.slice(1).map((r) => [r.ok, r.norm_id, r.error])).toEqual([
			[false, "BOE-A-2020-1", "json_parse"],
			[false, "BOE-A-2020-2", "finish_length"],
			[false, "BOE-A-2020-3", "request_error: server_error upstream"],
			[false, "BOE-A-2020-4", "request_error: missing_result"],
		]);
		const saved = loadState(statePath).batches[0];
		expect(saved?.collected_at).toBeDefined();
		expect(saved?.deleted_at).toBeDefined();
		expect(saved?.cost).toBe(0.01);
		expect(
			api.calls.filter((c) => c.method === "DELETE").map((c) => c.url),
		).toEqual(["https://openrouter.ai/api/v1/batches/b1"]);
	});

	test("rejects a reply the import would reject (second person)", async () => {
		const statePath = join(dir, "state.json");
		const outFile = join(dir, "out.jsonl");
		const { state } = planBatches("e.jsonl", [exportRow(0)]);
		submitted(state, 0, "b1");
		const bad = { ...SUMMARY, summary: "Ahora puedes pedir la ayuda." };
		const api = fakeApi({
			b1: {
				id: "b1",
				status: "completed",
				results: [
					{ custom_id: "r0", response: completion(JSON.stringify(bad)) },
				],
			},
		});
		await collectOnce(
			{ apiKey: "k", fetch: api.fetchFn },
			statePath,
			state,
			outFile,
			() => {},
		);
		expect(readRows(outFile)[0]).toMatchObject({
			ok: false,
			error: "invalid: second_person",
		});
	});

	test("running batches stay pending; a failed batch fails its rows", async () => {
		const statePath = join(dir, "state.json");
		const outFile = join(dir, "out.jsonl");
		const { state } = planBatches("e.jsonl", [exportRow(0), exportRow(1)], {
			chunk: 1,
		});
		submitted(state, 0, "b1");
		submitted(state, 1, "b2");
		const api = fakeApi({
			b1: { id: "b1", status: "in_progress", results: null },
			b2: { id: "b2", status: "expired", results: null },
		});
		const res = await collectOnce(
			{ apiKey: "k", fetch: api.fetchFn },
			statePath,
			state,
			outFile,
			() => {},
		);
		expect(res.pending).toBe(1);
		expect(state.batches[0]?.collected_at).toBeUndefined();
		expect(readRows(outFile)).toEqual([
			expect.objectContaining({
				ok: false,
				norm_id: "BOE-A-2020-1",
				error: "request_error: batch_expired",
			}),
		]);
		expect(api.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
	});

	test("collect is idempotent: no duplicate rows, retries a failed DELETE", async () => {
		const statePath = join(dir, "state.json");
		const outFile = join(dir, "out.jsonl");
		const { state } = planBatches("e.jsonl", [exportRow(0)]);
		submitted(state, 0, "b1");
		const api = fakeApi({
			b1: {
				id: "b1",
				status: "completed",
				results: [
					{ custom_id: "r0", response: completion(JSON.stringify(SUMMARY)) },
				],
			},
		});
		let deletes = 0;
		const flakyDelete: FetchFn = async (url, init) => {
			if (init?.method === "DELETE" && ++deletes === 1)
				return new Response("", { status: 503 });
			return api.fetchFn(url, init);
		};
		const first = await collectOnce(
			{ apiKey: "k", fetch: flakyDelete },
			statePath,
			state,
			outFile,
			() => {},
		);
		expect(first.pending).toBe(1); // DELETE still owed
		// A crash before the state was saved: collected_at lost, rows written.
		const reloaded = loadState(statePath);
		const chunk = reloaded.batches[0];
		if (chunk) chunk.collected_at = undefined;
		const second = await collectOnce(
			{ apiKey: "k", fetch: flakyDelete },
			statePath,
			reloaded,
			outFile,
			() => {},
		);
		expect(second).toEqual({ pending: 0, written: 0, ok: 0 });
		expect(readRows(outFile)).toHaveLength(1);
		expect(loadState(statePath).batches[0]?.deleted_at).toBeDefined();
	});
});
