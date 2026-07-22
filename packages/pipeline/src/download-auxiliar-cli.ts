/**
 * Download all BOE auxiliary data (reference tables).
 *
 * The exit code is meaningful: 0 = every endpoint produced a usable file,
 * 1 = at least one did not. The daily pipeline (Step 2.5) branches on it, so
 * this must NOT swallow failures the way it used to — a downloader that always
 * exits 0 turns every caller-side fallback into dead code.
 *
 * Writes are atomic (tmp + rename) and validated before promotion, so a 500
 * page, a truncated body or an empty payload can never clobber a good cached
 * copy. Losing that cache is what produced the 2026-07-22 materias incident.
 *
 * Usage:
 *   bun run packages/pipeline/src/download-auxiliar-cli.ts
 *   bun run packages/pipeline/src/download-auxiliar-cli.ts --check
 *     ↳ downloads nothing; exits 0 iff the on-disk materias.json is usable.
 */

import { rename } from "node:fs/promises";

const BASE = "https://www.boe.es/datosabiertos/api";
const OUT_DIR = "./data/auxiliar";

const ENDPOINTS = [
	"datos-auxiliares/materias",
	"datos-auxiliares/departamentos",
	"datos-auxiliares/rangos",
	"datos-auxiliares/ambitos",
	"datos-auxiliares/estados-consolidacion",
	"datos-auxiliares/relaciones-anteriores",
	"datos-auxiliares/relaciones-posteriores",
] as const;

/** Usable = `data` is a non-empty object (code → name) or a non-empty array. */
function payloadSize(json: unknown): number {
	const data = (json as { data?: unknown } | null)?.data;
	if (Array.isArray(data)) return data.length;
	if (data && typeof data === "object") return Object.keys(data).length;
	return 0;
}

async function checkCache(): Promise<number> {
	const path = `${OUT_DIR}/materias.json`;
	try {
		if (!(await Bun.file(path).exists())) {
			console.error(`--check: ${path} does not exist`);
			return 1;
		}
		const size = payloadSize(await Bun.file(path).json());
		if (size === 0) {
			console.error(`--check: ${path} has no usable "data" payload`);
			return 1;
		}
		console.log(`--check: ${path} OK (${size} materias)`);
		return 0;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`--check: ${path} unreadable (${msg})`);
		return 1;
	}
}

async function main() {
	if (process.argv.includes("--check")) {
		process.exit(await checkCache());
	}

	await Bun.write(`${OUT_DIR}/.gitkeep`, "");

	let failed = 0;

	for (const endpoint of ENDPOINTS) {
		const name = endpoint.split("/")[1]!;
		const url = `${BASE}/${endpoint}`;
		const path = `${OUT_DIR}/${name}.json`;
		console.log(`Downloading ${name}...`);

		try {
			const res = await fetch(url, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) {
				console.error(`  ERROR: HTTP ${res.status} — keeping existing ${path}`);
				failed++;
				continue;
			}
			const json = await res.json();
			const count = payloadSize(json);
			if (count === 0) {
				console.error(`  ERROR: empty/unexpected payload — keeping ${path}`);
				failed++;
				continue;
			}

			// Atomic promote: never leave a half-written reference table behind,
			// and never destroy the previous good copy on a partial write.
			const tmp = `${path}.tmp`;
			await Bun.write(tmp, JSON.stringify(json, null, 2));
			await rename(tmp, path);

			console.log(`  OK: ${count} items → ${path}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`  ERROR: ${msg} — keeping existing ${path}`);
			failed++;
		}
	}

	if (failed > 0) {
		console.error(`\nDone with ${failed}/${ENDPOINTS.length} failure(s).`);
		process.exit(1);
	}
	console.log("\nDone.");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
