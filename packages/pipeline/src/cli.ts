/**
 * Pipeline CLI.
 *
 * Usage:
 *   bun run pipeline bootstrap --country es [--limit N]
 *   bun run pipeline ingest [--db PATH] [--json PATH]
 *   bun run pipeline status [--state PATH]
 */

import { getCountry } from "./country.ts";
import { ingestJsonDir, openDatabase } from "./db/index.ts";
import { bootstrapFromApi } from "./pipeline.ts";
import { StateStore } from "./utils/state-store.ts";

// Register Spain
import "./spain/index.ts";

const OUTPUT_DIR = "./output/es";
const DATA_DIR = "./data";
const STATE_PATH = `${DATA_DIR}/state.json`;
const DB_PATH = `${DATA_DIR}/leylibre.db`;
const JSON_DIR = `${DATA_DIR}/json`;

const command = process.argv[2];

async function bootstrap() {
	const args = process.argv.slice(3);
	const countryCode = getArg(args, "--country") ?? "es";
	const limit = Number(getArg(args, "--limit") ?? "0"); // 0 = all

	const country = getCountry(countryCode);
	const client = country.client();
	const textParser = country.textParser();
	const metadataParser = country.metadataParser();

	const state = new StateStore(STATE_PATH, countryCode);
	await state.load();

	// Discover all norm IDs
	console.log(`Discovering norms from ${country.name}...`);
	const normIds: string[] = [];
	for await (const id of country.discovery().discoverAll(client)) {
		normIds.push(id);
		if (limit > 0 && normIds.length >= limit) break;
	}
	console.log(`Found ${normIds.length} norms.`);

	// Filter already processed
	const pending = normIds.filter((id) => !state.isProcessed(id));
	console.log(
		`${pending.length} pending (${normIds.length - pending.length} already done).\n`,
	);

	let processed = 0;
	const startTime = Date.now();
	const saveInterval = 10; // Save state every N norms

	for (let i = 0; i < pending.length; i++) {
		const normId = pending[i]!;
		const progress = `[${i + 1}/${pending.length}]`;

		try {
			const commits = await bootstrapFromApi(
				normId,
				client,
				textParser,
				metadataParser,
				{ repoPath: OUTPUT_DIR, dataDir: DATA_DIR },
			);

			if (commits === -1) {
				state.markSkipped(normId);
				console.log(`${progress} ${normId} — no text available`);
			} else if (commits === 0) {
				state.markDone(normId, 0);
				// Already up to date, don't log to reduce noise
			} else {
				state.markDone(normId, commits);
				console.log(`${progress} ${normId} — ${commits} commits`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			state.markError(normId, msg);
			console.error(`${progress} ${normId} — ERROR: ${msg}`);
		}

		processed++;

		// Periodic save
		if (processed % saveInterval === 0) {
			await state.save();
			const elapsed = (Date.now() - startTime) / 1000;
			const rate = processed / elapsed;
			const remaining = (pending.length - processed) / rate;
			console.log(
				`  → ${processed}/${pending.length} (${rate.toFixed(1)}/s, ~${formatDuration(remaining)} remaining)`,
			);
		}
	}

	await state.save();
	await client.close();

	const stats = state.stats;
	const elapsed = (Date.now() - startTime) / 1000;

	console.log("\n─── Bootstrap Summary ───");
	console.log(`Processed: ${processed} norms in ${formatDuration(elapsed)}`);
	console.log(`Done:      ${stats.done}`);
	console.log(`Errors:    ${stats.errors}`);
	console.log(`Skipped:   ${stats.skipped}`);
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
