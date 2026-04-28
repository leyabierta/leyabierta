/**
 * Migration: fix stale `rank` values in data/json/*.json cache.
 *
 * Background: the old RANK_MAP in boe-metadata.ts was off-by-one for several
 * codes (e.g. rango.codigo=1370 "Resolución" was mapped to "instruccion"
 * instead of "resolucion"). The rango.codigo is NOT stored in the JSON cache,
 * but the ELI source URL reliably encodes the type (e.g. /eli/es/res/ for
 * Resolución). This script uses the ELI URL to derive the correct rank and
 * rewrites affected files.
 *
 * Usage:
 *   # Dry run (default — no writes):
 *   bun run packages/pipeline/src/scripts/fix-rank-from-cache.ts
 *
 *   # Apply changes:
 *   bun run packages/pipeline/src/scripts/fix-rank-from-cache.ts --apply
 *
 *   # Limit for testing:
 *   bun run packages/pipeline/src/scripts/fix-rank-from-cache.ts --limit 50
 *   bun run packages/pipeline/src/scripts/fix-rank-from-cache.ts --apply --limit 50
 */

import { join } from "node:path";
import { Glob } from "bun";
import type { Rank } from "../models.ts";
import { extractShortTitle } from "../spain/boe-metadata.ts";

// ---------------------------------------------------------------------------
// ELI type code → Rank
// Derived from BOE's ELI conventions. Each entry maps the path segment after
// /eli/<jurisdiction>/ to a Rank value. Parallel to (but keyed differently
// from) RANK_MAP in spain/boe-metadata.ts (which is keyed by rango.codigo);
// the two MUST resolve to the same Rank for the same norm type.
// ---------------------------------------------------------------------------
const ELI_TO_RANK: Record<string, Rank> = {
	a: "acuerdo",
	ai: "acuerdo_internacional",
	c: "constitucion",
	cir: "circular",
	d: "decreto",
	dflg: "decreto",
	dl: "real_decreto_ley",
	dlf: "real_decreto_ley", // Decreto-ley Foral
	dlg: "decreto", // Decreto Legislativo autonómico
	ins: "instruccion",
	l: "ley",
	lf: "ley", // Ley Foral
	lo: "ley_organica",
	o: "orden",
	rd: "real_decreto",
	rdl: "real_decreto_ley",
	rdlg: "real_decreto_legislativo",
	reg: "reglamento",
	res: "resolucion",
};

/** Extract the ELI type code from a source URL, e.g. /eli/es/res/ → "res" */
function extractEliCode(source: string): string | null {
	const match = source.match(/\/eli\/[^/]+\/([^/]+)\//);
	return match ? (match[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : Infinity;
const jsonDir = "./data/json";

interface ChangeRecord {
	file: string;
	normId: string;
	oldRank: string;
	newRank: Rank;
}

interface ShortTitleRecord {
	file: string;
	normId: string;
	oldShortTitle: string;
	newShortTitle: string;
}

async function run() {
	const glob = new Glob("*.json");
	const changesByKind = new Map<string, ChangeRecord[]>();
	const shortTitleChanges: ShortTitleRecord[] = [];
	let scanned = 0;
	let noEli = 0;
	let noChange = 0;

	for await (const filename of glob.scan({ cwd: jsonDir })) {
		const filePath = join(jsonDir, filename);
		const raw = await Bun.file(filePath).text();
		let doc: Record<string, unknown>;
		try {
			doc = JSON.parse(raw);
		} catch {
			console.warn(`[skip] Cannot parse JSON: ${filename}`);
			continue;
		}

		const meta = doc.metadata as Record<string, string> | undefined;
		if (!meta) continue;

		const source = meta.source ?? "";
		const currentRank = meta.rank ?? "";
		const normId = meta.id ?? filename.replace(".json", "");
		const title = meta.title ?? "";

		// --- Rank fix ---
		const eliCode = extractEliCode(source);
		if (!eliCode) {
			noEli++;
		} else {
			const correctRank = ELI_TO_RANK[eliCode];
			if (correctRank && correctRank !== currentRank) {
				const key = `${currentRank} -> ${correctRank}`;
				if (!changesByKind.has(key)) changesByKind.set(key, []);
				changesByKind.get(key)!.push({
					file: filePath,
					normId,
					oldRank: currentRank,
					newRank: correctRank,
				});
				scanned++;
			} else if (correctRank === currentRank) {
				noChange++;
			}
			// Unknown ELI code → skip rather than guess (counted in noChange)
		}

		// --- short_title fix ---
		if (title) {
			const correctShortTitle = extractShortTitle(title);
			const currentShortTitle = meta.shortTitle ?? "";
			if (correctShortTitle !== currentShortTitle) {
				shortTitleChanges.push({
					file: filePath,
					normId,
					oldShortTitle: currentShortTitle,
					newShortTitle: correctShortTitle,
				});
			}
		}

		if (scanned >= limit) break;
	}

	// ---------------------------------------------------------------------------
	// Report
	// ---------------------------------------------------------------------------
	const totalRankChanges = [...changesByKind.values()].reduce(
		(s, a) => s + a.length,
		0,
	);

	console.log("=== fix-rank-from-cache ===");
	console.log(
		`Mode:             ${apply ? "APPLY (writes JSON files)" : "DRY RUN (no writes)"}`,
	);
	if (limit !== Infinity) console.log(`Limit:            ${limit}`);
	console.log(`No-ELI:           ${noEli} files skipped (no ELI source URL)`);
	console.log(`No-change (rank): ${noChange} files already correct`);
	console.log(`Rank changes:     ${totalRankChanges} files need rank updating`);
	console.log(
		`ShortTitle fixes: ${shortTitleChanges.length} files need short_title updating`,
	);
	console.log();

	if (totalRankChanges > 0) {
		console.log("--- Rank changes ---");
		for (const [kind, records] of [...changesByKind.entries()].sort(
			(a, b) => b[1].length - a[1].length,
		)) {
			console.log(`  ${kind}: ${records.length} files`);
			const examples = records.slice(0, 10);
			for (const r of examples) {
				console.log(`    ${r.normId}`);
			}
			if (records.length > 10) {
				console.log(`    … and ${records.length - 10} more`);
			}
		}
		console.log();
	}

	if (shortTitleChanges.length > 0) {
		console.log("--- short_title changes (first 10 examples) ---");
		for (const r of shortTitleChanges.slice(0, 10)) {
			console.log(`  ${r.normId}`);
			console.log(`    before: ${r.oldShortTitle}`);
			console.log(`    after:  ${r.newShortTitle}`);
		}
		if (shortTitleChanges.length > 10) {
			console.log(`  … and ${shortTitleChanges.length - 10} more`);
		}
		console.log();
	}

	if (!apply) {
		console.log("Run with --apply to rewrite the JSON files.");
		return;
	}

	// ---------------------------------------------------------------------------
	// Apply
	// ---------------------------------------------------------------------------
	console.log("Applying changes…");

	// Merge all files that need any update into a single pass.
	// Key: filePath → partial updates to apply.
	const updates = new Map<
		string,
		{ rank?: Rank; shortTitle?: string; normId: string }
	>();

	for (const records of changesByKind.values()) {
		for (const { file, normId, newRank } of records) {
			const entry = updates.get(file) ?? { normId };
			entry.rank = newRank;
			updates.set(file, entry);
		}
	}
	for (const { file, normId, newShortTitle } of shortTitleChanges) {
		const entry = updates.get(file) ?? { normId };
		entry.shortTitle = newShortTitle;
		updates.set(file, entry);
	}

	let written = 0;
	let failed = 0;

	for (const [file, { rank, shortTitle, normId }] of updates) {
		try {
			const raw = await Bun.file(file).text();
			const doc = JSON.parse(raw) as Record<string, unknown>;
			const meta = doc.metadata as Record<string, string>;
			if (rank !== undefined) meta.rank = rank;
			if (shortTitle !== undefined) meta.shortTitle = shortTitle;
			await Bun.write(file, JSON.stringify(doc, null, 2));
			written++;
		} catch (err) {
			console.error(`[error] ${normId}: ${err}`);
			failed++;
		}
	}

	console.log();
	console.log(`Written: ${written} files`);
	if (failed > 0) console.error(`Failed:  ${failed} files`);
	console.log("Done. Run `bun run ingest` to rebuild the SQLite database.");
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
