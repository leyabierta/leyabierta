/**
 * Pipeline CLI.
 *
 * Usage:
 *   bun run pipeline bootstrap --country es [--limit N]
 *   bun run pipeline ingest [--db PATH] [--json PATH]
 *   bun run pipeline status [--state PATH]
 */

import { getCountry } from "./country.ts";
import type { LegislativeClient, MetadataParser, TextParser } from "./country.ts";
import { ingestJsonDir, openDatabase } from "./db/index.ts";
import type { Norm } from "./models.ts";
import { commitNorm, fetchNorm } from "./pipeline.ts";
import { BoeClient } from "./spain/boe-client.ts";
import { StateStore } from "./utils/state-store.ts";

// Register Spain
import "./spain/index.ts";

const OUTPUT_DIR = process.env.REPO_PATH ?? "../leyes-es";
const DATA_DIR = "./data";
const STATE_PATH = `${DATA_DIR}/state.json`;
const DB_PATH = `${DATA_DIR}/leyabierta.db`;
const JSON_DIR = `${DATA_DIR}/json`;

const command = process.argv[2];

async function bootstrap() {
	const args = process.argv.slice(3);
	const countryCode = getArg(args, "--country") ?? "es";
	const limit = Number(getArg(args, "--limit") ?? "0"); // 0 = all
	const concurrency = Number(getArg(args, "--concurrency") ?? "6");

	const country = getCountry(countryCode);
	const discoveryClient = country.client();
	const textParser = country.textParser();
	const metadataParser = country.metadataParser();

	const state = new StateStore(STATE_PATH, countryCode);
	await state.load();

	// Discover all norm IDs
	console.log(`Discovering norms from ${country.name}...`);
	const normIds: string[] = [];
	for await (const id of country.discovery().discoverAll(discoveryClient)) {
		normIds.push(id);
		if (limit > 0 && normIds.length >= limit) break;
	}
	await discoveryClient.close();
	console.log(`Found ${normIds.length} norms.`);

	// Filter already processed
	const pending = normIds.filter((id) => !state.isProcessed(id));
	console.log(
		`${pending.length} pending (${normIds.length - pending.length} already done).\n`,
	);

	if (pending.length === 0) {
		console.log("Nothing to do.");
		return;
	}

	const startTime = Date.now();

	// ── Phase 1: Parallel fetch ──
	console.log(`Phase 1: Fetching ${pending.length} norms (${concurrency} workers)...\n`);

	const clients = Array.from({ length: concurrency }, () => new BoeClient());
	const fetched: Array<{ id: string; norm: Norm | null; error?: string }> = [];
	let fetchIndex = 0;
	let fetchDone = 0;

	async function fetchWorker(workerId: number) {
		const client = clients[workerId]!;
		while (fetchIndex < pending.length) {
			const i = fetchIndex++;
			const normId = pending[i]!;
			try {
				const norm = await fetchNorm(normId, client, textParser, metadataParser, DATA_DIR);
				fetched.push({ id: normId, norm });
				fetchDone++;
				if (fetchDone % 50 === 0 || fetchDone === pending.length) {
					const elapsed = (Date.now() - startTime) / 1000;
					const rate = fetchDone / elapsed;
					const remaining = (pending.length - fetchDone) / rate;
					console.log(
						`  fetch [${fetchDone}/${pending.length}] ${normId} (${rate.toFixed(1)}/s, ~${formatDuration(remaining)} remaining)`,
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				fetched.push({ id: normId, norm: null, error: msg });
				fetchDone++;
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, pending.length) }, (_, i) => fetchWorker(i)),
	);
	for (const c of clients) await c.close();

	const fetchElapsed = (Date.now() - startTime) / 1000;
	const fetchedOk = fetched.filter((f) => f.norm);
	const fetchErrors = fetched.filter((f) => f.error);
	const fetchSkipped = fetched.filter((f) => !f.norm && !f.error);
	console.log(
		`\nPhase 1 done: ${fetchedOk.length} fetched, ${fetchSkipped.length} skipped, ${fetchErrors.length} errors in ${formatDuration(fetchElapsed)}\n`,
	);

	// ── Phase 2: Sequential commit ──
	console.log(`Phase 2: Committing ${fetchedOk.length} norms to git...\n`);
	const commitStart = Date.now();

	for (let i = 0; i < fetched.length; i++) {
		const { id, norm, error } = fetched[i]!;

		if (error) {
			state.markError(id, error);
			if (fetchErrors.length <= 20) {
				console.error(`  ✗ ${id} — ERROR: ${error}`);
			}
			continue;
		}

		if (!norm) {
			state.markSkipped(id);
			continue;
		}

		try {
			const commits = await commitNorm(norm, { repoPath: OUTPUT_DIR, dataDir: DATA_DIR });

			if (commits === 0) {
				state.markDone(id, 0);
			} else {
				state.markDone(id, commits);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			state.markError(id, msg);
			console.error(`  ✗ ${id} — COMMIT ERROR: ${msg}`);
		}

		if ((i + 1) % 50 === 0) {
			await state.save();
			const elapsed = (Date.now() - commitStart) / 1000;
			const rate = (i + 1) / elapsed;
			const remaining = (fetched.length - i - 1) / rate;
			console.log(
				`  commit [${i + 1}/${fetched.length}] (${rate.toFixed(1)}/s, ~${formatDuration(remaining)} remaining)`,
			);
		}
	}

	await state.save();

	const totalElapsed = (Date.now() - startTime) / 1000;
	const stats = state.stats;

	console.log("\n─── Bootstrap Summary ───");
	console.log(`Fetch:   ${formatDuration(fetchElapsed)} (${concurrency} workers)`);
	console.log(`Commit:  ${formatDuration((Date.now() - commitStart) / 1000)}`);
	console.log(`Total:   ${formatDuration(totalElapsed)}`);
	console.log(`Done:    ${stats.done}`);
	console.log(`Errors:  ${stats.errors}`);
	console.log(`Skipped: ${stats.skipped}`);
}

async function ingest() {
	const args = process.argv.slice(3);
	const dbPath = getArg(args, "--db") ?? DB_PATH;
	const jsonDir = getArg(args, "--json") ?? JSON_DIR;

	console.log(`Ingesting JSON from ${jsonDir} into ${dbPath}`);
	const db = openDatabase(dbPath);
	const result = await ingestJsonDir(db, jsonDir);

	console.log("─── Ingest Summary ───");
	console.log(`Norms:    ${result.normsInserted}`);
	console.log(`Blocks:   ${result.blocksInserted}`);
	console.log(`Versions: ${result.versionsInserted}`);
	console.log(`Reforms:  ${result.reformsInserted}`);

	if (result.errors.length > 0) {
		console.error(`Errors: ${result.errors.length}`);
		for (const err of result.errors) console.error(`  • ${err}`);
	}

	db.close();
}

async function status() {
	const args = process.argv.slice(3);
	const statePath = getArg(args, "--state") ?? STATE_PATH;

	const state = new StateStore(statePath, "es");
	await state.load();
	const stats = state.stats;

	console.log("─── State Store ───");
	console.log(`Total:   ${stats.total}`);
	console.log(`Done:    ${stats.done}`);
	console.log(`Errors:  ${stats.errors}`);
	console.log(`Skipped: ${stats.skipped}`);
}

// ─── Helpers ───

function getArg(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx >= 0 ? args[idx + 1] : undefined;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	const h = Math.floor(seconds / 3600);
	const m = Math.round((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

// ─── Main ───

switch (command) {
	case "bootstrap":
		bootstrap().catch((err) => {
			console.error("Fatal:", err);
			process.exit(1);
		});
		break;
	case "ingest":
		ingest().catch((err) => {
			console.error("Fatal:", err);
			process.exit(1);
		});
		break;
	case "status":
		status().catch((err) => {
			console.error("Fatal:", err);
			process.exit(1);
		});
		break;
	default:
		console.log(`Usage:
  bun run pipeline bootstrap --country es [--limit N]
  bun run pipeline ingest [--db PATH] [--json PATH]
  bun run pipeline status [--state PATH]`);
		process.exit(command ? 1 : 0);
}
