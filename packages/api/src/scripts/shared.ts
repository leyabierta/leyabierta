/**
 * Shared utilities for batch scripts (generate-reform-summaries, generate-omnibus-topics).
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { DbService } from "../services/db.ts";

// ── CLI helpers ──

export function getArg(name: string): string | undefined {
	const args = process.argv.slice(2);
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}

export function hasFlag(name: string): boolean {
	return process.argv.slice(2).includes(`--${name}`);
}

// ── DB setup ──

export function setupDb(): { db: Database; dbService: DbService } {
	const repoRoot = join(import.meta.dir, "../../../../");
	const dbPath = join(repoRoot, "data", "leyabierta.db");
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	createSchema(db);
	return { db, dbService: new DbService(db) };
}

// ── Materia helpers ──

export function getMaterias(db: Database, normId: string): string[] {
	return db
		.query<{ materia: string }, [string]>(
			"SELECT materia FROM materias WHERE norm_id = ?",
		)
		.all(normId)
		.map((r) => r.materia);
}
