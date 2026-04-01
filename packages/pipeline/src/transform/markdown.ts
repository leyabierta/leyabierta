/**
 * Markdown generation from legislative blocks.
 *
 * Converts Block/Version/Paragraph structures into readable Markdown,
 * with headings reflecting the legal hierarchy.
 */

import type { Block, NormMetadata, Paragraph, Reform } from "../models.ts";
import { type AnalisisData, renderFrontmatter } from "./frontmatter.ts";
import { getBlockAtDate } from "./xml-parser.ts";

// ─── CSS class -> Markdown mapping ───

const SIMPLE_CSS_MAP: Record<string, (text: string) => string> = {
	// Structural headings
	titulo: (t) => `## ${t}\n`,
	titulo_tit: (t) => `## ${t}\n`,
	capitulo_tit: (t) => `### ${t}\n`,
	capitulo: (t) => `### ${t}\n`,
	seccion: (t) => `#### ${t}\n`,
	subseccion: (t) => `#### ${t}\n`,
	articulo: (t) => `---\n\n##### ${t}\n`,
	libro: (t) => `## ${t}\n`,
	anexo: (t) => `## ${t}\n`,

	// Centered/styled
	centro_redonda: (t) => `### ${t}\n`,
	centro_negrita: (t) => `# ${t}\n`,
	centro_cursiva: (t) => `*${t}*\n`,

	// Signatures
	firma_rey: (t) => `**${t}**\n`,
	firma_ministro: (t) => `${t}\n`,

	// Indented / quoted text
	sangrado: (t) => `> ${t}\n`,
	sangrado_2: (t) => `>> ${t}\n`,
	sangrado_articulo: (t) => `> ${t}\n`,
	cita: (t) => `> ${t}\n`,

	// Images (already converted to ![alt](src) by parser)
	imagen: (t) => `${t}\n`,

	// Correction notice at top of norm
	textoCompleto: (t) => `${t}\n`,
};

/** Paired CSS classes (num + tit) and their heading levels. */
const PAIRED_CLASSES: Record<string, { pair: string; level: string }> = {
	titulo_num: { pair: "titulo_tit", level: "##" },
	capitulo_num: { pair: "capitulo_tit", level: "###" },
	libro_num: { pair: "libro_tit", level: "##" },
	anexo_num: { pair: "anexo_tit", level: "##" },
};

export function renderParagraphs(paragraphs: readonly Paragraph[]): string {
	const lines: string[] = [];
	let i = 0;

	while (i < paragraphs.length) {
		const p = paragraphs[i]!;
		const css = p.cssClass;
		const text = p.text;

		// Pre-formatted tables
		if (css === "__table") {
			lines.push(text, "");
			i += 1;
			continue;
		}

		// Paired classes (num + tit)
		const paired = PAIRED_CLASSES[css];
		if (paired) {
			const next = paragraphs[i + 1];

			if (next && next.cssClass === paired.pair) {
				lines.push(`${paired.level} ${text}. ${next.text}`, "");
				i += 2;
				continue;
			}

			lines.push(`${paired.level} ${text}`, "");
			i += 1;
			continue;
		}

		// Simple mapped classes
		const formatter = SIMPLE_CSS_MAP[css];
		if (formatter) {
			lines.push(formatter(text).trimEnd(), "");
		} else {
			// Normal paragraph (parrafo, parrafo_2, table cell classes, etc.)
			lines.push(text, "");
		}

		i += 1;
	}

	return lines.join("\n");
}

export function renderNormAtDate(
	metadata: NormMetadata,
	blocks: readonly Block[],
	targetDate: string,
	reforms: readonly Reform[] = [],
	analisis?: AnalisisData,
): string {
	const parts: string[] = [];

	parts.push(
		renderFrontmatter(metadata, targetDate, reforms, blocks, analisis),
	);

	const title = metadata.title.replace(/[\s.]+$/, "").trim();
	parts.push(`# ${title}\n\n`);

	for (const block of blocks) {
		const version = getBlockAtDate(block, targetDate);
		if (!version) continue;

		const md = renderParagraphs(version.paragraphs);
		if (md.trim()) {
			parts.push(md);
			if (!md.endsWith("\n\n")) {
				parts.push("\n");
			}
		}
	}

	return parts.join("");
}
