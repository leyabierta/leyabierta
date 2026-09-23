/**
 * YAML frontmatter generation for norm Markdown files.
 *
 * User-facing content in Spanish following ELI conventions.
 */

import yaml from "js-yaml";
import type { Block, NormAnalisis, NormMetadata, Reform } from "../models.ts";
import { analisisToFrontmatter } from "./analisis.ts";
import { extractJurisdiction } from "./slug.ts";

/**
 * Analysis data as consumed by the renderers.
 *
 * Aliased to `NormAnalisis` rather than redeclared: the two were structurally
 * identical except that `NormAnalisis` is readonly, so passing a `NormAnalisis`
 * here failed to type-check (a readonly array is not assignable to a mutable
 * one) even though nothing in the render path mutates it.
 */
export type AnalisisData = NormAnalisis;

export function renderFrontmatter(
	metadata: NormMetadata,
	versionDate: string,
	reforms: readonly Reform[],
	blocks: readonly Block[],
	analisis?: AnalisisData,
): string {
	const title = cleanTitle(metadata.title);
	const jurisdiction = extractJurisdiction(metadata);

	const data: Record<string, unknown> = {
		titulo: title,
		identificador: metadata.id,
		pais: metadata.country,
		jurisdiccion: jurisdiction,
		rango: metadata.rank,
		fecha_publicacion: metadata.publishedAt,
		ultima_actualizacion: versionDate,
		estado: metadata.status,
		departamento: metadata.department,
		fuente: metadata.source,
	};

	if (metadata.pdfUrl) {
		data.pdf = metadata.pdfUrl;
	}

	// Article count (blocks of type "precepto" are articles)
	data.articulos = blocks.filter((b) => b.type === "precepto").length;

	// Reform timeline
	if (reforms.length > 0) {
		data.reformas = reforms.map((r) => ({
			fecha: r.date,
			fuente: r.normId,
		}));
	}

	// Analisis data (materias, notas, referencias): from the enriched JSON
	// cache, a fresh BOE fetch, or carried over from the file already on disk
	// (see pipeline.ts). Omitted only when none of those has any.
	Object.assign(data, analisisToFrontmatter(analisis));

	const yamlStr = yaml.dump(data, {
		lineWidth: -1,
		quotingType: '"',
		forceQuotes: false,
	});

	return `---\n${yamlStr}---\n\n`;
}

export function cleanTitle(title: string): string {
	let end = title.length;
	while (
		end > 0 &&
		(title[end - 1] === " " ||
			title[end - 1] === "." ||
			title[end - 1] === "\t" ||
			title[end - 1] === "\n" ||
			title[end - 1] === "\r")
	) {
		end--;
	}
	return title.slice(0, end);
}
