/**
 * Write materias/notas/referencias for a single norm directly to SQLite.
 *
 * Normally `ingest-analisis-cli.ts` is the only writer of these tables,
 * fetching from the BOE's consolidated `/analisis` endpoint + ELI HTML meta
 * tags. A freshly-published diario norm has neither yet — the consolidated
 * HTML page doesn't exist until the BOE consolidates it, 1-2 weeks later —
 * but its diario XML already carries complete materias/notas/referencias
 * (see `transform/diario-xml-parser.ts`). Writing them here lets a
 * diario-origin norm show up in `/v1/materias` immediately instead of
 * waiting for consolidation.
 *
 * Idempotent: deletes this norm's existing rows before inserting, mirroring
 * the cascade-delete pattern in `db/ingest.ts`. Table shapes match
 * `ingest-analisis-cli.ts` exactly so both writers stay interchangeable.
 */

import type { Database } from "bun:sqlite";
import type { NormAnalisis } from "../models.ts";

export function writeAnalisis(
	db: Database,
	normId: string,
	analisis: NormAnalisis,
): void {
	const deleteMaterias = db.prepare("DELETE FROM materias WHERE norm_id = ?");
	const deleteNotas = db.prepare("DELETE FROM notas WHERE norm_id = ?");
	const deleteRefs = db.prepare("DELETE FROM referencias WHERE norm_id = ?");
	const insertMateria = db.prepare(
		"INSERT OR IGNORE INTO materias (norm_id, materia) VALUES (?, ?)",
	);
	const insertNota = db.prepare(
		"INSERT OR REPLACE INTO notas (norm_id, nota, position) VALUES (?, ?, ?)",
	);
	const insertRef = db.prepare(
		"INSERT OR REPLACE INTO referencias (norm_id, direction, relation, target_id, text) VALUES (?, ?, ?, ?, ?)",
	);

	db.transaction(() => {
		deleteMaterias.run(normId);
		deleteNotas.run(normId);
		deleteRefs.run(normId);

		for (const materia of analisis.materias) {
			if (materia) insertMateria.run(normId, materia);
		}
		for (const [position, nota] of analisis.notas.entries()) {
			insertNota.run(normId, nota, position);
		}
		for (const ref of analisis.referencias.anteriores) {
			if (ref.normId) {
				insertRef.run(normId, "anterior", ref.relation, ref.normId, ref.text);
			}
		}
		for (const ref of analisis.referencias.posteriores) {
			if (ref.normId) {
				insertRef.run(normId, "posterior", ref.relation, ref.normId, ref.text);
			}
		}
	})();
}
