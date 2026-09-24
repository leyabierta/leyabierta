/**
 * Reform summaries through the OpenRouter Batch API (openai/gpt-6-luna:batch):
 * the reprocessing path of reform-summaries-offline.ts (`batch-submit`,
 * `batch-collect`). Takes an `export` JSONL, writes a JSONL in the exact
 * format of `generate`, so `import` validates it the same way.
 *
 * PRIVACY — decision of 2026-09-24: Zero Data Retention is mandatory for
 * citizens' questions (/v1/ask), not for public legislation. The Batch API is
 * NOT ZDR: OpenRouter keeps inputs and results for 30 days unless the batch is
 * deleted (collect DELETEs every batch it has read), and the upstream batch
 * record stays at OpenAI under its own retention (DELETE answers
 * `upstream: OpenAI "unsupported"`, checked 2026-09-24; OpenRouter does delete
 * the input/output files it uploaded there). That is acceptable ONLY because
 * the input is published legislation with no personal data. NEVER use this for
 * user questions or anything with personal data. Requests carry no `provider`
 * field: the Batch API accepts only `provider.only`, and the ZDR routing of
 * `openRouterProviderField()` stays on the synchronous routes.
 *
 * Kept apart from the CLI so it can be tested with a fake fetch.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readJsonl } from "./offline-llm.ts";
import {
	promptHash,
	validateGeneratedReform,
} from "./reform-summary-import.ts";
import {
	PROMPT_VERSION,
	REFORM_JSON_SCHEMA,
	REFORM_MAX_TOKENS,
	REFORM_SYSTEM_PROMPT,
	REFORM_TEMPERATURE,
	reformReasoning,
} from "./reform-summary-prompt.ts";

export const BATCHES_URL = "https://openrouter.ai/api/v1/batches";
/** The model id sent to the Batch API. */
export const BATCH_MODEL = "openai/gpt-6-luna:batch";
/** The model id stored in reform_summaries.model (same model, same request). */
export const BATCH_STORED_MODEL = "openai/gpt-6-luna";
export const MAX_CHUNK = 2000;
/** Consecutive 404s on GET before a submitted batch is given up as lost. */
export const LOST_AFTER_404S = 3;
const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);

/** A row of `reform-summaries-offline.ts export`. */
export interface ExportRow {
	norm_id: string;
	source_id: string;
	reform_date: string;
	user: string;
	input_hash: string;
	prompt_version: string;
}

export interface BatchItem {
	norm_id: string;
	source_id: string;
	reform_date: string;
	input_hash: string;
	prompt_version: string;
}

export interface BatchChunk {
	custom_ids: string[];
	id?: string;
	submitted_at?: string;
	status?: string;
	collected_at?: string;
	deleted_at?: string;
	cost?: number;
	/** Consecutive 404s on GET; LOST_AFTER_404S of them mark it lost. */
	not_found?: number;
	/** Why the batch was given up (its reforms are written as failed). */
	lost?: string;
}

export interface BatchState {
	version: 1;
	export_file: string;
	/** sha256 of the export: submit refuses any other content, same path or not. */
	export_sha256: string;
	prompt_version: string;
	model: string;
	created_at: string;
	/**
	 * custom_id → reform. custom_id is `r<index of the row among the parsed
	 * export rows>`; export_sha256 pins which export that index refers to, and
	 * submit re-checks key and prompt hash of each row before sending it.
	 */
	items: Record<string, BatchItem>;
	batches: BatchChunk[];
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface BatchApi {
	apiKey: string;
	fetch?: FetchFn;
	baseUrl?: string;
}

const keyOf = (r: {
	norm_id: string;
	source_id: string;
	reform_date: string;
}) => `${r.norm_id}|${r.source_id}|${r.reform_date}`;

/**
 * The body of one request: what the daily cron sends through callOpenRouter
 * for openai/* (same system prompt, temperature, max tokens, reasoning and
 * strict JSON schema), minus the OpenRouter routing fields (`provider`,
 * `plugins`) and `model`, which the batch sets once.
 */
export function batchRequestBody(user: string): Record<string, unknown> {
	return {
		messages: [
			{ role: "system", content: REFORM_SYSTEM_PROMPT },
			{ role: "user", content: user },
		],
		temperature: REFORM_TEMPERATURE,
		max_tokens: REFORM_MAX_TOKENS,
		reasoning: reformReasoning(BATCH_STORED_MODEL),
		response_format: {
			type: "json_schema",
			json_schema: {
				name: REFORM_JSON_SCHEMA.name,
				strict: true,
				schema: REFORM_JSON_SCHEMA.schema,
			},
		},
	};
}

/** `endpoint` and `model` must precede `requests` (OpenRouter stream-parses it). */
export function batchPayload(
	requests: { custom_id: string; body: Record<string, unknown> }[],
): string {
	return JSON.stringify({
		endpoint: "/v1/chat/completions",
		model: BATCH_MODEL,
		requests,
	});
}

/** sha256 (hex) of a file's bytes. */
export function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Throws unless `sha256` is the export the state was planned from. */
export function assertSameExport(state: BatchState, sha256: string) {
	if (state.export_sha256 !== sha256)
		throw new Error(
			`the export changed since the state was planned (sha256 ${sha256.slice(0, 12)}… vs ${String(state.export_sha256).slice(0, 12)}…): plan a new state file`,
		);
}

/** Why an export row cannot be sent, or undefined. */
function refusal(
	r: ExportRow | null,
	seen: Set<string>,
	skipKeys?: Set<string>,
): string | undefined {
	if (!r?.norm_id || !r.source_id || !r.reform_date || !r.user)
		return "bad_row";
	if (r.prompt_version !== PROMPT_VERSION) return "prompt_version_changed";
	if (
		promptHash({ system: REFORM_SYSTEM_PROMPT, user: r.user }) !== r.input_hash
	)
		return "prompt_hash_mismatch";
	const key = keyOf(r);
	if (seen.has(key)) return "duplicate_in_export";
	if (skipKeys?.has(key)) return "already_done";
	return undefined;
}

/**
 * Plans a new state from an export: every row with the current prompt
 * (version and hash) gets a custom_id and a chunk. Rows built with another
 * prompt are refused, since import would reject their result anyway.
 */
export function planBatches(
	exportFile: string,
	exportSha256: string,
	rows: ExportRow[],
	opts: { chunk?: number; limit?: number; skipKeys?: Set<string> } = {},
): { state: BatchState; refused: Record<string, number> } {
	const chunk = opts.chunk ?? MAX_CHUNK;
	if (!Number.isInteger(chunk) || chunk < 1 || chunk > MAX_CHUNK)
		throw new Error(`--chunk must be between 1 and ${MAX_CHUNK}`);
	const refused: Record<string, number> = {};
	const state: BatchState = {
		version: 1,
		export_file: exportFile,
		export_sha256: exportSha256,
		prompt_version: PROMPT_VERSION,
		model: BATCH_MODEL,
		created_at: new Date().toISOString(),
		items: {},
		batches: [],
	};
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const [line, r] of rows.entries()) {
		if (opts.limit && ids.length >= opts.limit) break;
		const why = refusal(r, seen, opts.skipKeys);
		if (why) {
			refused[why] = (refused[why] ?? 0) + 1;
			continue;
		}
		seen.add(keyOf(r));
		const id = `r${line}`;
		state.items[id] = {
			norm_id: r.norm_id,
			source_id: r.source_id,
			reform_date: r.reform_date,
			input_hash: r.input_hash,
			prompt_version: r.prompt_version,
		};
		ids.push(id);
	}
	for (let i = 0; i < ids.length; i += chunk)
		state.batches.push({ custom_ids: ids.slice(i, i + chunk) });
	return { state, refused };
}

export function loadState(path: string): BatchState {
	const state = JSON.parse(readFileSync(path, "utf8")) as BatchState;
	if (state.version !== 1) throw new Error(`${path}: unknown state version`);
	return state;
}

/** Written to a temp file and renamed: a crash never leaves half a state. */
export function saveState(path: string, state: BatchState) {
	writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 1)}\n`);
	renameSync(`${path}.tmp`, path);
}

function headers(api: BatchApi): Record<string, string> {
	return {
		Authorization: `Bearer ${api.apiKey}`,
		"Content-Type": "application/json",
		"HTTP-Referer": "https://leyabierta.es",
		"X-Title": "Ley Abierta",
	};
}

/**
 * The prompt to send for a custom_id, checked against what the state planned:
 * same reform, and a prompt whose hash is the planned `input_hash`. Guards
 * against a result landing under another reform's key.
 */
function checkedUser(
	state: BatchState,
	id: string,
	rowOf: (customId: string) => ExportRow | undefined,
): string {
	const item = state.items[id];
	const row = rowOf(id);
	if (!item || !row) throw new Error(`${id}: not in the state or the export`);
	if (keyOf(row) !== keyOf(item))
		throw new Error(
			`${id}: the export row is ${keyOf(row)}, the state planned ${keyOf(item)}`,
		);
	if (
		promptHash({ system: REFORM_SYSTEM_PROMPT, user: row.user }) !==
		item.input_hash
	)
		throw new Error(`${id}: prompt differs from the planned input_hash`);
	return row.user;
}

/**
 * Submits chunks that have no batch id yet (at most `maxChunks`), saving the
 * state after each one, so a rerun resumes where it stopped. `rowOf` gives the
 * export row of a custom_id; every id of a chunk is checked before it is sent.
 */
export async function submitBatches(
	api: BatchApi,
	statePath: string,
	state: BatchState,
	rowOf: (customId: string) => ExportRow | undefined,
	log: (msg: string) => void = console.log,
	maxChunks = Number.POSITIVE_INFINITY,
): Promise<number> {
	if (state.prompt_version !== PROMPT_VERSION)
		throw new Error(
			`state built with prompt ${state.prompt_version}, code has ${PROMPT_VERSION}: export again`,
		);
	const fetchFn = api.fetch ?? fetch;
	let submitted = 0;
	for (const [n, chunk] of state.batches.entries()) {
		if (chunk.id) continue;
		if (submitted >= maxChunks) break;
		const requests = chunk.custom_ids.map((id) => ({
			custom_id: id,
			body: batchRequestBody(checkedUser(state, id, rowOf)),
		}));
		const res = await fetchFn(api.baseUrl ?? BATCHES_URL, {
			method: "POST",
			headers: headers(api),
			body: batchPayload(requests),
		});
		const data = (await res.json().catch(() => ({}))) as {
			id?: string;
			status?: string;
			error?: unknown;
		};
		if (!res.ok || !data.id)
			throw new Error(
				`batch ${n + 1}/${state.batches.length}: HTTP ${res.status} ${JSON.stringify(data.error ?? data).slice(0, 300)}`,
			);
		chunk.id = data.id;
		chunk.status = data.status;
		chunk.submitted_at = new Date().toISOString();
		saveState(statePath, state);
		submitted++;
		log(
			`batch ${n + 1}/${state.batches.length}: ${data.id} (${requests.length} requests, ${data.status})`,
		);
	}
	return submitted;
}

interface BatchResultItem {
	custom_id?: string;
	response?: {
		status_code?: number;
		body?: {
			choices?: {
				message?: { content?: string | null; refusal?: string | null };
				finish_reason?: string;
			}[];
			usage?: unknown;
		};
	} | null;
	error?: { code?: string; message?: string } | null;
}

interface BatchObject {
	id?: string;
	status?: string;
	request_counts?: { total?: number; completed?: number; failed?: number };
	usage?: { cost?: number } | null;
	results?: BatchResultItem[] | null;
	error?: unknown;
	// Not in the documented API (results come inline, whole, with no
	// pagination); if any appears, the results may be partial.
	has_more?: unknown;
	next?: unknown;
	output_file_id?: unknown;
	results_url?: unknown;
}

/**
 * Why a terminal batch's inline results look incomplete, or undefined: fewer
 * results than request_counts reports, or a pagination/file hint.
 */
export function incompleteResults(batch: BatchObject): string | undefined {
	for (const k of [
		"has_more",
		"next",
		"output_file_id",
		"results_url",
	] as const) {
		const v = batch[k];
		if (v !== undefined && v !== null && v !== false)
			return `unexpected field ${k}`;
	}
	// Any terminal status: an expired/cancelled/failed batch may have
	// finished (and billed) requests whose results are not in the response.
	const rc = batch.request_counts ?? {};
	const expected = (rc.completed ?? 0) + (rc.failed ?? 0);
	const got = batch.results?.length ?? 0;
	if (got < expected)
		return `${got} results for ${expected} finished requests (status ${batch.status})`;
	return undefined;
}

/**
 * One output row for one result, in the format of `generate`:
 * `{ ok: true, norm_id, source_id, reform_date, input_hash, prompt_version,
 * model, result, finish, usage }` or `{ ok: false, …key, error }`. A reply
 * the import would reject is already an ok:false row here, with the reason,
 * so it can be sent again.
 */
export function resultRow(
	item: BatchItem,
	res: BatchResultItem,
): Record<string, unknown> {
	const key = {
		norm_id: item.norm_id,
		source_id: item.source_id,
		reform_date: item.reform_date,
	};
	const fail = (error: string) => ({
		ok: false,
		...key,
		input_hash: item.input_hash,
		prompt_version: item.prompt_version,
		model: BATCH_STORED_MODEL,
		error: error.slice(0, 300),
	});
	if (res.error || !res.response)
		return fail(
			`request_error: ${[res.error?.code, res.error?.message ?? "no response"].filter(Boolean).join(" ")}`,
		);
	if (res.response.status_code !== 200)
		return fail(`http_${res.response.status_code}`);
	const choice = res.response.body?.choices?.[0];
	if (choice?.message?.refusal)
		return fail(`refusal: ${choice.message.refusal}`);
	if (choice?.finish_reason !== "stop")
		return fail(`finish_${choice?.finish_reason ?? "none"}`);
	let result: unknown;
	try {
		result = JSON.parse(choice.message?.content ?? "");
	} catch {
		return fail("json_parse");
	}
	const row = {
		ok: true,
		...key,
		input_hash: item.input_hash,
		prompt_version: item.prompt_version,
		model: BATCH_STORED_MODEL,
		result,
		finish: choice.finish_reason,
		usage: res.response.body?.usage,
	};
	const v = validateGeneratedReform(row);
	return v.ok ? row : fail(`invalid: ${v.reason}`);
}

export interface CollectReport {
	/** Submitted batches still to collect or delete. */
	pending: number;
	/** Chunks never submitted (collect cannot help them). */
	unsubmitted: number;
	/**
	 * Terminal batches whose results look incomplete: not collected, not
	 * deleted, and not worth polling (waiting will not change them). Check by
	 * hand; `acceptIncomplete` collects them, missing results as failed rows.
	 */
	blocked: number;
	written: number;
	ok: number;
}

/**
 * One pass over the submitted chunks: a chunk in a terminal status with
 * complete results is written to `outFile` (every custom_id gets exactly one
 * row; a missing result is an ok:false row), marked collected, then DELETEd.
 * Chunks still running, or whose results look partial, are left for the next
 * pass. A batch that answers 404 LOST_AFTER_404S times in a row is given up:
 * its reforms are written as failed. Reforms that already have an ok row in
 * `outFile` are not written again (a crash before saving the state is
 * harmless).
 */
export async function collectOnce(
	api: BatchApi,
	statePath: string,
	state: BatchState,
	outFile: string,
	log: (msg: string) => void = console.log,
	opts: { acceptIncomplete?: boolean } = {},
): Promise<CollectReport> {
	const fetchFn = api.fetch ?? fetch;
	const base = api.baseUrl ?? BATCHES_URL;
	const done = new Set<string>();
	if (existsSync(outFile))
		for (const o of readJsonl<Record<string, unknown>>(outFile).rows)
			if (o.ok === true)
				done.add(`${o.norm_id}|${o.source_id}|${o.reform_date}`);

	const report: CollectReport = {
		pending: 0,
		unsubmitted: 0,
		blocked: 0,
		written: 0,
		ok: 0,
	};
	/** Appends one row per reform of the chunk that has no ok row yet. */
	const writeRows = (
		chunk: BatchChunk,
		rowFor: (item: BatchItem, id: string) => Record<string, unknown>,
	): number => {
		const lines: string[] = [];
		for (const id of chunk.custom_ids) {
			const item = state.items[id];
			if (!item || done.has(keyOf(item))) continue;
			const row = rowFor(item, id);
			if (row.ok === true) {
				report.ok++;
				done.add(keyOf(item));
			}
			lines.push(JSON.stringify(row));
		}
		if (lines.length > 0)
			writeFileSync(outFile, `${lines.join("\n")}\n`, { flag: "a" });
		report.written += lines.length;
		return lines.length;
	};

	for (const [n, chunk] of state.batches.entries()) {
		const label = `batch ${n + 1}/${state.batches.length}`;
		if (!chunk.id) {
			report.unsubmitted++;
			continue;
		}
		if (!chunk.collected_at) {
			const res = await fetchFn(`${base}/${chunk.id}`, {
				headers: headers(api),
			});
			if (res.status === 404) {
				chunk.not_found = (chunk.not_found ?? 0) + 1;
				if (chunk.not_found < LOST_AFTER_404S) {
					saveState(statePath, state);
					report.pending++;
					log(
						`${label} ${chunk.id}: GET 404 (${chunk.not_found}/${LOST_AFTER_404S}), retry later`,
					);
					continue;
				}
				// Gone (deleted elsewhere, or past OpenRouter's retention): its
				// reforms are written as failed, to be sent again.
				const lost = `GET 404 x${chunk.not_found}`;
				chunk.lost = lost;
				const lines = writeRows(chunk, (item) =>
					resultRow(item, { error: { code: "batch_lost", message: lost } }),
				);
				chunk.collected_at = new Date().toISOString();
				chunk.deleted_at = chunk.collected_at;
				saveState(statePath, state);
				log(`${label} ${chunk.id}: LOST (${lost}), ${lines} rows failed`);
				continue;
			}
			if (!res.ok) {
				report.pending++;
				log(`${label} ${chunk.id}: GET HTTP ${res.status}, retry later`);
				continue;
			}
			let batch: BatchObject;
			try {
				batch = (await res.json()) as BatchObject;
			} catch {
				report.pending++;
				log(`${label} ${chunk.id}: GET returned invalid JSON, retry later`);
				continue;
			}
			chunk.not_found = 0;
			chunk.status = batch.status;
			log(
				`${label} ${chunk.id}: ${batch.status} ${JSON.stringify(batch.request_counts ?? {})}`,
			);
			if (!batch.status || !TERMINAL.has(batch.status)) {
				report.pending++;
				continue;
			}
			const incomplete = incompleteResults(batch);
			if (incomplete && !opts.acceptIncomplete) {
				// Never collect (nor DELETE) a batch whose results may be partial,
				// unless asked to after checking it by hand.
				report.blocked++;
				log(
					`${label} ${chunk.id}: WARNING results look incomplete (${incomplete}); not collected, not deleted (--accept-incomplete to collect it anyway)`,
				);
				continue;
			}
			if (incomplete)
				log(
					`${label} ${chunk.id}: collecting incomplete results (${incomplete})`,
				);
			const byId = new Map<string, BatchResultItem>();
			for (const r of batch.results ?? [])
				if (r.custom_id) byId.set(r.custom_id, r);
			const lines = writeRows(chunk, (item, id) => {
				const r = byId.get(id);
				if (r) return resultRow(item, r);
				return resultRow(item, {
					error: {
						code:
							batch.status === "completed"
								? "missing_result"
								: `batch_${batch.status}`,
						message: batch.error
							? JSON.stringify(batch.error).slice(0, 200)
							: "",
					},
				});
			});
			chunk.cost = batch.usage?.cost;
			chunk.collected_at = new Date().toISOString();
			saveState(statePath, state);
			log(`${label}: ${lines} rows written`);
		}
		if (!chunk.deleted_at) {
			// Purges OpenRouter's copy now instead of after 30 days.
			const del = await fetchFn(`${base}/${chunk.id}`, {
				method: "DELETE",
				headers: headers(api),
			});
			if (del.ok || del.status === 404) {
				chunk.deleted_at = new Date().toISOString();
				saveState(statePath, state);
				log(
					`${label}: deleted (${(await del.text().catch(() => "")).slice(0, 160)})`,
				);
			} else {
				report.pending++;
				log(`${label}: DELETE HTTP ${del.status}, retry on the next pass`);
			}
		}
	}
	if (report.unsubmitted > 0)
		log(
			`${report.unsubmitted} batches not submitted yet: run batch-submit to send them`,
		);
	return report;
}
