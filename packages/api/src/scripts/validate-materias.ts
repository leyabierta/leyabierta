/**
 * Validate that all materia strings in materia-mappings.ts exist in the database.
 */
import { Database } from "bun:sqlite";
import {
	BASE_MATERIAS,
	EXTRAS_MATERIAS,
	FAMILY_MATERIAS,
	HOUSING_MATERIAS,
	SECTOR_MATERIAS,
	WORK_STATUS_MATERIAS,
} from "../data/materia-mappings.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const db = new Database(DB_PATH);

// Collect all unique materias from mappings
const allMaterias = new Set<string>();
for (const arr of [
	BASE_MATERIAS,
	...Object.values(WORK_STATUS_MATERIAS),
	...Object.values(SECTOR_MATERIAS),
	...Object.values(HOUSING_MATERIAS),
	...Object.values(FAMILY_MATERIAS),
	...Object.values(EXTRAS_MATERIAS),
]) {
	for (const m of arr) allMaterias.add(m);
}

console.log(`Checking ${allMaterias.size} unique materia strings...`);

// Check each against DB
const dbMaterias = new Set(
	db
		.query<{ materia: string }, []>("SELECT DISTINCT materia FROM materias")
		.all()
		.map((r) => r.materia),
);

let missing = 0;
for (const m of allMaterias) {
	if (!dbMaterias.has(m)) {
		console.error(`MISSING: "${m}"`);
		// Try to find close matches
		const lower = m.toLowerCase();
		const close = [...dbMaterias].filter((d) =>
			d.toLowerCase().includes(lower.slice(0, 15)),
		);
		if (close.length > 0) {
			console.error(`  Did you mean: ${close.slice(0, 3).join(", ")}?`);
		}
		missing++;
	}
}

if (missing === 0) {
	console.log("All materia strings validated successfully.");
} else {
	console.error(`\n${missing} materia(s) not found in database.`);
	process.exit(1);
}

db.close();
