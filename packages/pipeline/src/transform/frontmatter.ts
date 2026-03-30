/**
 * YAML frontmatter generation for norm Markdown files.
 *
 * User-facing content in Spanish following ELI conventions.
 */

import type { NormMetadata } from "../models.ts";
import { extractJurisdiction } from "./slug.ts";

export function renderFrontmatter(
	metadata: NormMetadata,
	versionDate: string,
): string {
	const title = cleanTitle(metadata.title);
	const jurisdiction = extractJurisdiction(metadata);

	const lines = [
		"---",
		`titulo: "${escapeYaml(title)}"`,
		`identificador: "${metadata.id}"`,
		`pais: "${metadata.country}"`,
		`jurisdiccion: "${jurisdiction}"`,
		`rango: "${metadata.rank}"`,
		`fecha_publicacion: "${metadata.publishedAt}"`,
		`ultima_actualizacion: "${versionDate}"`,
		`estado: "${metadata.status}"`,
		`departamento: "${escapeYaml(metadata.department)}"`,
		`fuente: "${metadata.source}"`,
	];

	if (metadata.pdfUrl) {
		lines.push(`pdf: "${metadata.pdfUrl}"`);
	}

	lines.push("---", "");

	return lines.join("\n");
}

function escapeYaml(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function cleanTitle(title: string): string {
	return title.replace(/[\s.]+$/, "").trim();
}
