/**
 * BOE análisis data (materias, notas, referencias) in its three homes:
 *
 *   - the JSON cache (`data/json/<id>.json` → `analisis`), filled from the DB
 *     by `ingest-analisis` (Step 3 of the daily pipeline);
 *   - the `leyes` frontmatter (`materias`, `notas`, `referencias_*`);
 *   - the `Norm` model (`norm.analisis`).
 *
 * Why this module exists: `fetchNorm` (the daily `pipeline bootstrap`) never
 * loaded análisis, so every file it wrote to `leyes` had no `materias` /
 * `notas` / `referencias_*`, and it also overwrote the JSON cache without the
 * `analisis` key until Step 3 put it back. These helpers let the pipeline
 * carry análisis over from the cache or from the file already on disk instead
 * of silently dropping it.
 */

import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { NormAnalisis } from "../models.ts";

type Ref = { normId: string; relation: string; text: string };

/** Frontmatter keys that hold análisis data, in the order they are rendered. */
export const ANALISIS_KEYS = [
	"materias",
	"notas",
	"referencias_anteriores",
	"referencias_posteriores",
] as const;

/** True when the análisis carries no data at all. */
export function isEmptyAnalisis(a: NormAnalisis | undefined): boolean {
	return (
		!a ||
		(a.materias.length === 0 &&
			a.notas.length === 0 &&
			a.referencias.anteriores.length === 0 &&
			a.referencias.posteriores.length === 0)
	);
}

/**
 * Frontmatter fields for an análisis, in render order. Empty lists are
 * omitted (the frontmatter never carries `materias: []`).
 */
export function analisisToFrontmatter(
	analisis: NormAnalisis | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!analisis) return out;
	const refs = (list: readonly Ref[]) =>
		list.map((r) => ({ norma: r.normId, relacion: r.relation, texto: r.text }));
	if (analisis.materias.length > 0) out.materias = [...analisis.materias];
	if (analisis.notas.length > 0) out.notas = [...analisis.notas];
	if (analisis.referencias.anteriores.length > 0) {
		out.referencias_anteriores = refs(analisis.referencias.anteriores);
	}
	if (analisis.referencias.posteriores.length > 0) {
		out.referencias_posteriores = refs(analisis.referencias.posteriores);
	}
	return out;
}

/** Code-unit (byte-order for BMP text) comparison, like SQLite's BINARY. */
const binaryCompare = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0;

/**
 * References in the exact shape Step 3 (`ingest-analisis`) stores them in the
 * JSON cache: dropped when they have no target norm, one per
 * (target, relation) with the last text winning (the DB primary key +
 * `INSERT OR REPLACE`), sorted by target then relation (the DB query order).
 *
 * `BoeClient.getNormAnalisis` must produce this shape: otherwise a new law's
 * first commit would carry the BOE's order and its next commit, rendered from
 * the Step-3 cache, would reorder every reference in the public `leyes` diff.
 */
export function canonicalRefs(list: readonly Ref[]): Ref[] {
	const byKey = new Map<string, Ref>();
	for (const r of list) {
		if (!r.normId) continue;
		const key = `${r.normId}\u0000${r.relation}`;
		byKey.delete(key);
		byKey.set(key, { normId: r.normId, relation: r.relation, text: r.text });
	}
	return [...byKey.values()].sort(
		(a, b) =>
			binaryCompare(a.normId, b.normId) ||
			binaryCompare(a.relation, b.relation),
	);
}

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.map((x) => String(x)) : [];

const frontmatterRefs = (v: unknown): Ref[] =>
	(Array.isArray(v) ? v : [])
		.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
		.map((r) => ({
			normId: String(r.norma ?? ""),
			relation: String(r.relacion ?? ""),
			text: String(r.texto ?? ""),
		}));

/** Análisis from a parsed frontmatter object; undefined if it has none. */
export function analisisFromFrontmatter(
	data: Record<string, unknown>,
): NormAnalisis | undefined {
	if (!ANALISIS_KEYS.some((k) => k in data)) return undefined;
	const analisis: NormAnalisis = {
		materias: strings(data.materias),
		notas: strings(data.notas),
		referencias: {
			anteriores: frontmatterRefs(data.referencias_anteriores),
			posteriores: frontmatterRefs(data.referencias_posteriores),
		},
	};
	return isEmptyAnalisis(analisis) ? undefined : analisis;
}

/**
 * Split a leyes markdown file into its YAML frontmatter (without the `---`
 * fences) and the rest. `rest` starts right after the closing `---`, so
 * `---\n${yaml}\n---${rest}` rebuilds the file byte for byte.
 */
export function splitFrontmatter(
	markdown: string,
): { yaml: string; rest: string } | null {
	if (!markdown.startsWith("---\n")) return null;
	const end = markdown.indexOf("\n---", 4);
	if (end === -1) return null;
	return { yaml: markdown.slice(4, end), rest: markdown.slice(end + 4) };
}

/** Parse a frontmatter YAML string, keeping dates as strings. */
export function parseFrontmatterYaml(
	src: string,
): Record<string, unknown> | null {
	try {
		// CORE_SCHEMA: no implicit timestamps, so dates stay strings.
		const data = yaml.load(src, { schema: yaml.CORE_SCHEMA });
		return data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Análisis in an existing leyes file's frontmatter, if any. */
export function readAnalisisFromMarkdown(
	markdown: string | undefined,
): NormAnalisis | undefined {
	if (!markdown) return undefined;
	const parts = splitFrontmatter(markdown);
	if (!parts) return undefined;
	const data = parseFrontmatterYaml(parts.yaml);
	return data ? analisisFromFrontmatter(data) : undefined;
}

const cachedRefs = (v: unknown): Ref[] =>
	(Array.isArray(v) ? v : [])
		.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
		.map((r) => ({
			normId: String(r.normId ?? ""),
			relation: String(r.relation ?? ""),
			text: String(r.text ?? ""),
		}));

/**
 * Análisis from a JSON cache object (the `analisis` key written by
 * `ingest-analisis`). Undefined when absent or empty.
 */
export function parseCachedAnalisis(raw: unknown): NormAnalisis | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const a = (raw as Record<string, unknown>).analisis;
	if (!a || typeof a !== "object") return undefined;
	const rec = a as Record<string, unknown>;
	const refs = (rec.referencias ?? {}) as Record<string, unknown>;
	const analisis: NormAnalisis = {
		materias: strings(rec.materias),
		notas: strings(rec.notas),
		referencias: {
			anteriores: cachedRefs(refs.anteriores),
			posteriores: cachedRefs(refs.posteriores),
		},
	};
	return isEmptyAnalisis(analisis) ? undefined : analisis;
}

/** Análisis of the JSON cache file at `path`, if it exists and has any. */
export function readCachedAnalisis(path: string): NormAnalisis | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseCachedAnalisis(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return undefined;
	}
}
