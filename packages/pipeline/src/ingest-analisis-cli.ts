/**
 * Download and ingest análisis data (materias, notas, referencias) for all norms in DB.
 *
 * Materias come from two sources:
 * 1. /analisis endpoint (partial)
 * 2. ELI meta tags in the BOE HTML (complete) + data/auxiliar/materias.json lookup
 *
 * Uses parallel workers for speed (~4x faster than sequential).
 *
 * Usage: bun run packages/pipeline/src/ingest-analisis-cli.ts [db-path] [--concurrency N]
 */

import { Database } from "bun:sqlite";
import { createSchema } from "./db/schema.ts";
import { BoeClient } from "./spain/boe-client.ts";

const dbPath = process.argv[2] || "./data/leyabierta.db";
const concurrency = Number(
	process.argv.includes("--concurrency")
		? process.argv[process.argv.indexOf("--concurrency") + 1]
		: "6",
);
const materiasPath = "./data/auxiliar/materias.json";

async function main() {
	const db = new Database(dbPath);
	createSchema(db);

	// Load materias lookup (code → name)
	let materiaLookup: Record<string, string> = {};
	try {
		const raw = await Bun.file(materiasPath).json();
		materiaLookup = raw.data ?? {};
	} catch {
		console.warn("Warning: could not load materias lookup from", materiasPath);
	}

	const norms = db
		.query<{ id: string }, []>("SELECT id FROM norms ORDER BY id")
		.all();

	console.log(
		`Downloading análisis for ${norms.length} norms (concurrency: ${concurrency})...\n`,
	);

	const insertMateria = db.prepare(
		"INSERT OR IGNORE INTO materias (norm_id, materia) VALUES (?, ?)",
	);
	const insertNota = db.prepare(
		"INSERT OR REPLACE INTO notas (norm_id, nota, position) VALUES (?, ?, ?)",
	);
	const insertRef = db.prepare(
		"INSERT OR REPLACE INTO referencias (norm_id, direction, relation, target_id, text) VALUES (?, ?, ?, ?, ?)",
	);

	let done = 0;
	let errors = 0;
	const startTime = Date.now();

	async function processNorm(
		normId: string,
		boe: BoeClient,
	): Promise<{ materias: number; refs: number }> {
		const analisis = await boe.getAnalisis(normId);
		const materiaCodes = await boe.getMateriaCodes(normId);
		const fullMaterias =
			materiaCodes.length > 0
				? materiaCodes.map((code) => materiaLookup[code] ?? `[código ${code}]`)
				: analisis.materias;

		// DB writes are synchronous and fast — no contention issue
		db.transaction(() => {
			for (const materia of fullMaterias) {
				if (materia) insertMateria.run(normId, materia);
			}
			for (let j = 0; j < analisis.notas.length; j++) {
				insertNota.run(normId, analisis.notas[j], j);
			}
			for (const ref of analisis.referencias.anteriores) {
				if (ref.normId) {
					insertRef.run(normId, "anterior", ref.relation, ref.normId, ref.text);
				}
			}
			for (const ref of analisis.referencias.posteriores) {
				if (ref.normId) {
					insertRef.run(
						normId,
						"posterior",
						ref.relation,
						ref.normId,
						ref.text,
					);
				}
			}
		})();

		return {
			materias: fullMaterias.length,
			refs:
				analisis.referencias.anteriores.length +
				analisis.referencias.posteriores.length,
		};
	}

	// Create one BoeClient per worker (each has its own rate limiter)
	const clients = Array.from({ length: concurrency }, () => new BoeClient());
	let nextIndex = 0;

	async function worker(workerId: number) {
		const boe = clients[workerId]!;
		while (nextIndex < norms.length) {
			const i = nextIndex++;
			const normId = norms[i]!.id;
			try {
				const result = await processNorm(normId, boe);
				done++;
				if (done % 50 === 0 || done === norms.length) {
					const elapsed = (Date.now() - startTime) / 1000;
					const rate = done / elapsed;
					const remaining = (norms.length - done) / rate;
					const mins = Math.round(remaining / 60);
					console.log(
						`[${done}/${norms.length}] ${normId} — ${result.materias} materias, ${result.refs} refs (${rate.toFixed(1)}/s, ~${mins}m remaining)`,
					);
				}
			} catch (err) {
				errors++;
				const msg = err instanceof Error ? err.message : String(err);
				if (errors <= 20) {
					console.error(`[${i + 1}/${norms.length}] ${normId} — ERROR: ${msg}`);
				}
			}
		}
	}

	// Launch workers
	await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

	// Cleanup
	for (const c of clients) await c.close();
	db.close();

	const elapsed = Math.round((Date.now() - startTime) / 1000);
	console.log("\n─── Analisis Ingest Summary ───");
	console.log(`Done:   ${done}`);
	console.log(`Errors: ${errors}`);
	console.log(`Time:   ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
