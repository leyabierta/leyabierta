/**
 * YAML frontmatter generation for norm Markdown files.
 *
 * User-facing content in Spanish following ELI conventions.
 */

import yaml from "js-yaml";
import type { Block, NormMetadata, Reform } from "../models.ts";
import { extractJurisdiction } from "./slug.ts";

export interface AnalisisData {
	materias: string[];
	notas: string[];
	referencias: {
		anteriores: Array<{
			normId: string;
			relation: string;
			text: string;
		}>;
		posteriores: Array<{
			normId: string;
			relation: string;
			text: string;
		}>;
	};
}

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

	// Analisis data (if available from enriched JSON cache)
	if (analisis) {
		if (analisis.materias.length > 0) {
			data.materias = analisis.materias;
		}
		if (analisis.notas.length > 0) {
			data.notas = analisis.notas;
		}
		if (analisis.referencias.anteriores.length > 0) {
			data.referencias_anteriores = analisis.referencias.anteriores.map(
				(r) => ({
					norma: r.normId,
					relacion: r.relation,
					texto: r.text,
				}),
			);
		}
		if (analisis.referencias.posteriores.length > 0) {
			data.referencias_posteriores = analisis.referencias.posteriores.map(
				(r) => ({
					norma: r.normId,
					relacion: r.relation,
					texto: r.text,
				}),
			);
		}
	}

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
