/**
 * Download and ingest análisis data (materias, notas, referencias) for all norms in DB.
 *
 * Materias come from two sources:
 * 1. /analisis endpoint (partial)
 * 2. ELI meta tags in the BOE HTML (complete) + data/auxiliar/materias.json lookup
 *
 * Usage: bun run packages/pipeline/src/ingest-analisis-cli.ts [db-path]
 */

import { Database } from "bun:sqlite";
import { createSchema } from "./db/schema.ts";
import { BoeClient } from "./spain/boe-client.ts";

const dbPath = process.argv[2] || "./data/leylibre.db";
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

	const boe = new BoeClient();

	const norms = db
		.query<{ id: string }, []>("SELECT id FROM norms ORDER BY id")
		.all();

	console.log(`Downloading análisis for ${norms.length} norms...\n`);

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

	for (let i = 0; i < norms.length; i++) {
		const normId = norms[i]!.id;
		try {
			// Fetch análisis (references, notas, partial materias)
			const analisis = await boe.getAnalisis(normId);

			// Fetch complete materias from ELI meta tags
			const materiaCodes = await boe.getMateriaCodes(normId);
			const fullMaterias =
				materiaCodes.length > 0
					? materiaCodes.map(
							(code) => materiaLookup[code] ?? `[código ${code}]`,
						)
					: analisis.materias;

			db.transaction(() => {
				for (const materia of fullMaterias) {
					if (materia) insertMateria.run(normId, materia);
				}
				for (let j = 0; j < analisis.notas.length; j++) {
					insertNota.run(normId, analisis.notas[j], j);
				}
				for (const ref of analisis.referencias.anteriores) {
					if (ref.normId) {
						insertRef.run(
							normId,
							"anterior",
							ref.relation,
							ref.normId,
							ref.text,
						);
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

			done++;
			if ((i + 1) % 10 === 0 || i === norms.length - 1) {
				console.log(
					`[${i + 1}/${norms.length}] ${normId} — ${fullMaterias.length} materias, ${analisis.referencias.anteriores.length + analisis.referencias.posteriores.length} refs`,
				);
			}
		} catch (err) {
			errors++;
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[${i + 1}/${norms.length}] ${normId} — ERROR: ${msg}`);
		}
	}

	await boe.close();
	db.close();

	console.log("\n─── Analisis Ingest Summary ───");
	console.log(`Done:   ${done}`);
	console.log(`Errors: ${errors}`);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
