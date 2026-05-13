#!/usr/bin/env bun
/**
 * Export Gemini embeddings from SQLite → flat binary for fast chunked search.
 *
 * WHY THIS SCRIPT EXISTS
 * ─────────────────────
 * The prod Qwen stack uses `data/vectors.bin` + `data/vectors.meta.jsonl`.
 * The Gemini corpus embeddings (483,983 vectors @ 3072 dims) still live in the
 * SQLite `embeddings` table under model='gemini-embedding-2' from before Phase 6.
 * This script exports them to a separate binary so the `rag-gemini-legacy` eval
 * retriever can load them without touching the Qwen binary.
 *
 * OUTPUT FILES
 * ────────────
 * - data/vectors-gemini.bin        — raw Float32 data, row-major (count × 3072 floats)
 * - data/vectors-gemini.meta.jsonl — one {"n":"<normId>","b":"<blockId>"} per line,
 *                                     same order as the binary rows
 *
 * FORMAT
 * ──────
 * Identical to the Qwen export produced by ensureVectorIndex() in embeddings.ts:
 * - Each vector: 3072 × float32 = 12,288 bytes
 * - Total: 483,983 × 12,288 ≈ 5.7 GB
 * - Meta: 483,983 lines of compact JSON (≈ 30 MB)
 *
 * RUNTIME ESTIMATE
 * ────────────────
 * ~15 minutes on a 2023 MacBook Pro M3 (SQLite read + disk write bound).
 * Progress is reported every 50,000 vectors.
 *
 * RE-RUN SAFETY
 * ─────────────
 * If vectors-gemini.bin already exists and its line count matches the DB count,
 * the script exits early (no-op). Pass --force to overwrite.
 *
 * USAGE
 * ─────
 *   bun run packages/api/scripts/export-gemini-vectors.ts
 *   bun run packages/api/scripts/export-gemini-vectors.ts --force
 *   bun run packages/api/scripts/export-gemini-vectors.ts --db /path/to/leyabierta.db
 *   bun run packages/api/scripts/export-gemini-vectors.ts --out /path/to/data
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

// ── Arg parsing ───────────────────────────────────────────────────────────────

const MODEL_KEY = "gemini-embedding-2";
const DIMS = 3072;
const EXPECTED_BYTES_PER_VEC = DIMS * 4; // float32

const argv = process.argv.slice(2);
const repoRoot = join(import.meta.dir, "../../../");
const defaultDataDir = join(repoRoot, "data");

let dbPath = join(defaultDataDir, "leyabierta.db");
let outDir = defaultDataDir;
let force = false;

for (let i = 0; i < argv.length; i++) {
	switch (argv[i]) {
		case "--db":
			dbPath = argv[++i] ?? dbPath;
			break;
		case "--out":
			outDir = argv[++i] ?? outDir;
			break;
		case "--force":
			force = true;
			break;
		default:
			console.warn(`Unknown arg: ${argv[i]}`);
	}
}

const vecPath = join(outDir, "vectors-gemini.bin");
const metaPath = join(outDir, "vectors-gemini.meta.jsonl");

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`[export-gemini-vectors] DB: ${dbPath}`);
	console.log(`[export-gemini-vectors] Output: ${vecPath}`);

	const db = new Database(dbPath, { readonly: true });

	// Count expected vectors.
	const dbCount =
		db
			.query<{ cnt: number }, [string]>(
				"SELECT COUNT(*) as cnt FROM embeddings WHERE model = ?",
			)
			.get(MODEL_KEY)?.cnt ?? 0;

	if (dbCount === 0) {
		console.error(
			`[export-gemini-vectors] ERROR: No embeddings found for model='${MODEL_KEY}' in ${dbPath}.`,
		);
		console.error(
			"  The Gemini corpus embeddings must exist in the 'embeddings' table.",
		);
		console.error(
			"  They were generated during the Phase 3-4 A/B and should still be there.",
		);
		process.exit(1);
	}

	console.log(
		`[export-gemini-vectors] Found ${dbCount.toLocaleString()} vectors (${MODEL_KEY}, ${DIMS} dims)`,
	);
	console.log(
		`[export-gemini-vectors] Estimated output: ${((dbCount * EXPECTED_BYTES_PER_VEC) / 1e9).toFixed(2)} GB binary + meta JSONL`,
	);

	// Check if files are already up to date.
	if (!force) {
		const metaFile = Bun.file(metaPath);
		const vecFile = Bun.file(vecPath);
		if ((await metaFile.exists()) && (await vecFile.exists())) {
			const lines = (await metaFile.text()).split("\n").filter(Boolean).length;
			if (lines === dbCount) {
				console.log(
					`[export-gemini-vectors] Already up to date (${lines} vectors). Use --force to overwrite.`,
				);
				db.close();
				return;
			}
			console.log(
				`[export-gemini-vectors] Stale files (${lines} lines vs ${dbCount} DB rows). Re-exporting...`,
			);
		}
	} else {
		console.log("[export-gemini-vectors] --force: overwriting existing files.");
	}

	// Export.
	const start = Date.now();
	const vecFile = Bun.file(vecPath).writer();
	const metaLines: string[] = [];

	const stmt = db.query<
		{ norm_id: string; block_id: string; vector: Buffer },
		[string]
	>(
		"SELECT norm_id, block_id, vector FROM embeddings WHERE model = ? ORDER BY norm_id, block_id",
	);

	let exported = 0;
	let skipped = 0;

	for (const row of stmt.iterate(MODEL_KEY)) {
		if (row.vector.byteLength !== EXPECTED_BYTES_PER_VEC) {
			console.warn(
				`[export-gemini-vectors] SKIP ${row.norm_id}/${row.block_id}: expected ${EXPECTED_BYTES_PER_VEC}B, got ${row.vector.byteLength}B`,
			);
			skipped++;
			continue;
		}

		metaLines.push(JSON.stringify({ n: row.norm_id, b: row.block_id }));
		vecFile.write(
			new Uint8Array(
				row.vector.buffer,
				row.vector.byteOffset,
				EXPECTED_BYTES_PER_VEC,
			),
		);
		exported++;

		if (exported % 50_000 === 0) {
			const pct = ((exported / dbCount) * 100).toFixed(1);
			const elapsedS = ((Date.now() - start) / 1000).toFixed(0);
			const eta =
				(((Date.now() - start) / exported) * (dbCount - exported)) / 1000;
			process.stdout.write(
				`\r  ${exported.toLocaleString()} / ${dbCount.toLocaleString()} (${pct}%) — ${elapsedS}s elapsed, ~${eta.toFixed(0)}s remaining  `,
			);
			vecFile.flush();
		}
	}

	await vecFile.end();
	await Bun.write(metaPath, metaLines.join("\n"));

	process.stdout.write("\n");

	const elapsedS = ((Date.now() - start) / 1000).toFixed(1);
	console.log(
		`[export-gemini-vectors] Done: ${exported.toLocaleString()} vectors exported in ${elapsedS}s`,
	);

	if (skipped > 0) {
		console.warn(
			`[export-gemini-vectors] WARNING: ${skipped} vectors skipped (dimension mismatch).`,
		);
	}

	const vecFileSizeGB = (Bun.file(vecPath).size / 1e9).toFixed(2);
	console.log(
		`[export-gemini-vectors] vectors-gemini.bin: ${vecFileSizeGB} GB`,
	);
	console.log(
		`[export-gemini-vectors] vectors-gemini.meta.jsonl: ${metaLines.length.toLocaleString()} lines`,
	);
	console.log("\nNext step: run the eval with --retriever rag-gemini-legacy");

	db.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
