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
import type {
	Block,
	Norm,
	NormMetadata,
	Paragraph,
	Rank,
	Reform,
	Version,
} from "./models.ts";
import { commitNormsChronologically, fetchNorm } from "./pipeline.ts";
import { BoeClient } from "./spain/boe-client.ts";
import { StateStore } from "./utils/state-store.ts";

// Register Spain
import "./spain/index.ts";

const OUTPUT_DIR = process.env.REPO_PATH ?? "../leyes";
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

	// Filter: skip only norms marked done (errors are retried)
	// With --force flag, re-process all norms (useful for catching updates)
	const force = args.includes("--force");
	const pending = force
		? normIds
		: normIds.filter((id) => !state.isProcessed(id));
	console.log(
		force
			? `Force mode: re-processing all ${normIds.length} norms.\n`
			: `${pending.length} pending (${normIds.length - pending.length} already done).\n`,
	);

	if (pending.length === 0) {
		console.log("Nothing to do.");
		return;
	}

	const startTime = Date.now();

	// ── Phase 1: Parallel fetch ──
	console.log(
		`Phase 1: Fetching ${pending.length} norms (${concurrency} workers)...\n`,
	);

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
				const norm = await fetchNorm(
					normId,
					client,
					textParser,
					metadataParser,
					DATA_DIR,
				);
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
		Array.from({ length: Math.min(concurrency, pending.length) }, (_, i) =>
			fetchWorker(i),
		),
	);
	for (const c of clients) await c.close();

	const fetchElapsed = (Date.now() - startTime) / 1000;
	const fetchedOk = fetched.filter((f) => f.norm);
	const fetchErrors = fetched.filter((f) => f.error);
	const fetchSkipped = fetched.filter((f) => !f.norm && !f.error);
	console.log(
		`\nPhase 1 done: ${fetchedOk.length} fetched, ${fetchSkipped.length} skipped, ${fetchErrors.length} errors in ${formatDuration(fetchElapsed)}\n`,
	);

	// ── Phase 2: Chronological commit ──
	// Mark fetch errors/skips in state first
	for (const { id, error, norm } of fetched) {
		if (error) {
			state.markError(id, error);
			if (fetchErrors.length <= 20) {
				console.error(`  ✗ ${id} — ERROR: ${error}`);
			}
		} else if (!norm) {
			state.markSkipped(id);
		}
	}

	const norms = fetchedOk.map((f) => f.norm!);
	console.log(
		`Phase 2: Committing ${norms.length} norms in chronological order...\n`,
	);
	const commitStart = Date.now();
	let lastProgressLog = 0;

	const totalCommits = await commitNormsChronologically(
		norms,
		{ repoPath: OUTPUT_DIR, dataDir: DATA_DIR },
		(done, total, subject) => {
			const now = Date.now();
			if (done === 1 || done === total || now - lastProgressLog > 2000) {
				const elapsed = (now - commitStart) / 1000;
				const rate = done / elapsed;
				const remaining = (total - done) / rate;
				console.log(
					`  [${done}/${total}] ${subject} (${rate.toFixed(1)}/s, ~${formatDuration(remaining)} remaining)`,
				);
				lastProgressLog = now;
			}
		},
	);

	// Mark all successfully fetched norms as done
	for (const { id, norm } of fetchedOk) {
		state.markDone(id, norm!.reforms.length);
	}

	await state.save();

	const totalElapsed = (Date.now() - startTime) / 1000;
	const stats = state.stats;

	console.log("\n─── Bootstrap Summary ───");
	console.log(
		`Fetch:   ${formatDuration(fetchElapsed)} (${concurrency} workers)`,
	);
	console.log(`Commit:  ${formatDuration((Date.now() - commitStart) / 1000)}`);
	console.log(`Commits: ${totalCommits} (chronological order)`);
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

async function rebuild() {
	const args = process.argv.slice(3);
	const jsonDir = getArg(args, "--json") ?? JSON_DIR;
	const repoPath = getArg(args, "--repo") ?? OUTPUT_DIR;
	const limit = Number(getArg(args, "--limit") ?? "0");

	console.log(`Rebuilding git repo from cached JSONs in ${jsonDir}...`);
	console.log(`Output: ${repoPath}\n`);

	const files = (
		await Array.fromAsync(new Bun.Glob("*.json").scan(jsonDir))
	).sort();
	const total = limit > 0 ? Math.min(files.length, limit) : files.length;
	console.log(
		`Found ${files.length} JSON files${limit > 0 ? `, using first ${total}` : ""}.\n`,
	);

	console.log("Phase 1: Loading norms from JSON cache...");
	const norms: Norm[] = [];
	let errors = 0;

	for (let i = 0; i < total; i++) {
		const file = files[i]!;
		try {
			const raw = await Bun.file(`${jsonDir}/${file}`).json();
			const norm = jsonToNorm(raw);
			if (norm.reforms.length > 0) {
				norms.push(norm);
			}
		} catch (err) {
			errors++;
			if (errors <= 10) {
				console.error(
					`  ✗ ${file}: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
	}
	console.log(`Loaded ${norms.length} norms (${errors} errors).\n`);

	console.log("Phase 2: Committing in chronological order...\n");
	const startTime = Date.now();
	let lastLog = 0;

	const commits = await commitNormsChronologically(
		norms,
		{ repoPath, dataDir: DATA_DIR },
		(done, totalEntries, subject) => {
			const now = Date.now();
			if (done === 1 || done === totalEntries || now - lastLog > 2000) {
				const elapsed = (now - startTime) / 1000;
				const rate = done / elapsed;
				const remaining = (totalEntries - done) / rate;
				console.log(
					`  [${done}/${totalEntries}] ${subject} (${rate.toFixed(1)}/s, ~${formatDuration(remaining)} remaining)`,
				);
				lastLog = now;
			}
		},
	);

	const elapsed = (Date.now() - startTime) / 1000;
	console.log(`\n─── Rebuild Summary ───`);
	console.log(`Norms:   ${norms.length}`);
	console.log(`Commits: ${commits} (chronological order)`);
	console.log(`Errors:  ${errors}`);
	console.log(`Time:    ${formatDuration(elapsed)}`);
}

/**
 * Infer CSS class from paragraph text when the original class was lost
 * during JSON serialization. Detects common legislative structure patterns.
 */
function inferCssClass(text: string): string {
	const trimmed = text.trim();

	// Structural headings (Spanish legislative conventions)
	if (/^TÍTULO\s/i.test(trimmed) || /^TITULO\s/i.test(trimmed)) return "titulo";
	if (/^CAPÍTULO\s/i.test(trimmed) || /^CAPITULO\s/i.test(trimmed))
		return "capitulo";
	if (/^SECCIÓN\s/i.test(trimmed) || /^SECCION\s/i.test(trimmed))
		return "seccion";
	if (/^SUBSECCIÓN\s/i.test(trimmed) || /^SUBSECCION\s/i.test(trimmed))
		return "subseccion";
	if (/^LIBRO\s/i.test(trimmed)) return "libro";
	if (/^ANEXO/i.test(trimmed)) return "anexo";

	// Article headings
	if (/^Artículo\s+\d/i.test(trimmed) || /^Articulo\s+\d/i.test(trimmed))
		return "articulo";

	// Disposiciones
	if (/^Disposición\s/i.test(trimmed) || /^Disposicion\s/i.test(trimmed))
		return "capitulo";

	// Preámbulo / exposición de motivos
	if (/^PREÁMBULO$/i.test(trimmed) || /^PREAMBULO$/i.test(trimmed))
		return "centro_negrita";
	if (/^EXPOSICIÓN DE MOTIVOS$/i.test(trimmed)) return "centro_negrita";

	return "parrafo";
}

/** Reconstruct a Norm from its cached JSON representation. */
function jsonToNorm(raw: Record<string, unknown>): Norm {
	const m = raw.metadata as Record<string, string>;
	const metadata: NormMetadata = {
		title: m.title,
		shortTitle: m.shortTitle,
		id: m.id,
		country: m.country,
		rank: m.rank as Rank,
		publishedAt: m.published,
		updatedAt: m.updated,
		status: m.status as NormMetadata["status"],
		department: m.department,
		source: m.source,
	};

	const articles = raw.articles as Array<Record<string, unknown>>;
	const blocks: Block[] = articles.map((a) => ({
		id: a.blockId as string,
		type: a.blockType as string,
		title: a.title as string,
		versions: (a.versions as Array<Record<string, string>>).map(
			(v): Version => ({
				normId: v.sourceId,
				publishedAt: v.date,
				effectiveAt: v.date,
				paragraphs: (v.text ?? "").split("\n\n").map(
					(text): Paragraph => ({
						cssClass: inferCssClass(text),
						text,
					}),
				),
			}),
		),
	}));

	const reforms: Reform[] = (raw.reforms as Array<Record<string, unknown>>).map(
		(r) => ({
			date: r.date as string,
			normId: r.sourceId as string,
			affectedBlockIds: (r.affectedBlocks as string[]) ?? [],
		}),
	);

	return { metadata, blocks, reforms };
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
	case "rebuild":
		rebuild().catch((err) => {
			console.error("Fatal:", err);
			process.exit(1);
		});
		break;
	default:
		console.log(`Usage:
  bun run pipeline bootstrap --country es [--limit N]
  bun run pipeline rebuild [--json PATH] [--repo PATH] [--limit N]
  bun run pipeline ingest [--db PATH] [--json PATH]
  bun run pipeline status [--state PATH]`);
		process.exit(command ? 1 : 0);
}
