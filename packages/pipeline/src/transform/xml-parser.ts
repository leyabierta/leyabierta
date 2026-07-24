/**
 * BOE XML parser.
 *
 * Parses the consolidated text XML from the BOE API into
 * Block/Version/Paragraph structures using fast-xml-parser
 * for robust tree-based parsing instead of fragile regex.
 */

import { XMLParser } from "fast-xml-parser";
import type { Block, Paragraph, Reform, Version } from "../models.ts";
import { parseBoeDate } from "../utils/date.ts";
import {
	normalizeWhitespace,
	renderInlineNodes,
	tableToMarkdown,
	type XmlNode,
} from "./xml-inline.ts";

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	preserveOrder: true,
	trimValues: false,
	processEntities: false, // We decode entities ourselves in renderInlineNodes
	// Note: blockquotes are NOT in stopNodes — we parse them to extract
	// "siempreSeVe" annotations (substantive editorial notes from the BOE
	// consolidator). Regular editorial blockquotes (nota_pie) are filtered
	// in extractParagraphs().
});

/**
 * Parse BOE consolidated text XML into blocks.
 */
export function parseTextXml(data: Uint8Array): Block[] {
	const text = new TextDecoder().decode(data);
	const doc = xmlParser.parse(text) as XmlNode[];

	// Navigate: response > data > texto > bloque[]
	// Or bare: bloque[] (for test fixtures without the response wrapper)
	const bloqueNodes = findBloques(doc);
	const blocks: Block[] = [];

	for (const node of bloqueNodes) {
		const attrs = node[":@"] ?? {};
		const id = (attrs.id as string) ?? "";
		const tipo = ((attrs.tipo as string) ?? "").toLowerCase();
		const titulo = (attrs.titulo as string) ?? "";

		const children: XmlNode[] = node.bloque ?? [];
		const versions = parseVersionNodes(children);

		blocks.push({ id, type: tipo, title: titulo, versions });
	}

	return blocks;
}

/** Find bloque nodes anywhere in the XML tree. */
function findBloques(nodes: XmlNode[]): XmlNode[] {
	for (const node of nodes) {
		// Direct bloque at root (test fixtures)
		if (node.bloque) return [node, ...findBloques(nodes.slice(1))];

		// Navigate through response > data > texto
		if (node.response) {
			const data = (node.response as XmlNode[]).find((n: XmlNode) => n.data);
			if (data) {
				const texto = (data.data as XmlNode[]).find((n: XmlNode) => n.texto);
				if (texto) {
					return (texto.texto as XmlNode[]).filter((n: XmlNode) => n.bloque);
				}
			}
		}
	}
	return [];
}

function parseVersionNodes(children: XmlNode[]): Version[] {
	const versions: Version[] = [];

	for (const child of children) {
		if (!child.version) continue;

		const attrs = child[":@"] ?? {};
		const normId = (attrs.id_norma as string) ?? "";
		const publishedAt = parseBoeDate((attrs.fecha_publicacion as string) ?? "");
		const effectiveAt = parseBoeDate((attrs.fecha_vigencia as string) ?? "");

		if (!publishedAt) continue;

		const versionChildren: XmlNode[] = child.version ?? [];
		const paragraphs = extractParagraphs(versionChildren);

		versions.push({
			normId,
			publishedAt,
			effectiveAt: effectiveAt ?? publishedAt,
			paragraphs,
		});
	}

	return versions;
}

// ─── Editorial note filtering ───

const EDITORIAL_CLASSES = new Set(["nota_pie", "nota_pie_2", "cita_con_pleca"]);

const EDITORIAL_PREFIXES = [
	"Téngase en cuenta",
	"Redactado conforme a la corrección",
	"Redacción anterior:",
	"Esta modificación",
	"Véase en cuanto",
	"Véase, en cuanto",
	"Su anterior numeración",
	"En el mismo sentido se pronuncia",
	"Se deja sin efecto",
	"Se declara",
	"Y por conexión",
	"Se modifica por",
	"Se añade por",
	"Se deroga por",
];

function isEditorialNote(cssClass: string, text: string): boolean {
	if (EDITORIAL_CLASSES.has(cssClass)) return true;
	return EDITORIAL_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// ─── Paragraph extraction ───

export function extractParagraphs(versionChildren: XmlNode[]): Paragraph[] {
	const paragraphs: Paragraph[] = [];

	for (const child of versionChildren) {
		// Handle blockquotes: include "siempreSeVe" notes, skip others
		if (child.blockquote) {
			const bqClass = (child[":@"]?.class as string) ?? "";
			if (bqClass === "siempreSeVe") {
				// Extract text from <p> elements inside the blockquote
				const bqChildren: XmlNode[] = child.blockquote ?? [];
				for (const bqChild of bqChildren) {
					if (!bqChild.p) continue;
					const text = normalizeWhitespace(
						renderInlineNodes(bqChild.p as XmlNode[]),
					);
					if (!text) continue;
					paragraphs.push({
						cssClass: "nota_boe",
						text: `[Nota del BOE: ${text}]`,
					});
				}
			}
			continue;
		}

		// Handle tables
		if (child.table) {
			const md = tableToMarkdown(child.table as XmlNode[]);
			if (md) {
				paragraphs.push({ cssClass: "__table", text: md });
			}
			continue;
		}

		// Handle <p> elements
		if (child.p) {
			const cssClass = (child[":@"]?.class as string) ?? "";
			const text = normalizeWhitespace(renderInlineNodes(child.p as XmlNode[]));

			if (!text) continue;
			if (isEditorialNote(cssClass, text)) continue;

			paragraphs.push({ cssClass, text });
		}
	}

	return paragraphs;
}

// ─── Shared utilities ───

/**
 * Extract the reform timeline from parsed blocks.
 */
export function extractReforms(blocks: readonly Block[]): Reform[] {
	const seen = new Set<string>();
	const reforms: Reform[] = [];

	for (const block of blocks) {
		for (const version of block.versions) {
			const key = `${version.publishedAt}|${version.normId}`;
			if (seen.has(key)) continue;
			seen.add(key);

			reforms.push({
				date: version.publishedAt,
				normId: version.normId,
				affectedBlockIds: blocks
					.filter((b) =>
						b.versions.some(
							(v) =>
								v.publishedAt === version.publishedAt &&
								v.normId === version.normId,
						),
					)
					.map((b) => b.id),
			});
		}
	}

	return reforms.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get the version of a block that was in effect at a given date.
 */
export function getBlockAtDate(
	block: Block,
	targetDate: string,
): Version | undefined {
	const applicable = block.versions
		.filter((v) => v.publishedAt <= targetDate)
		.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

	return applicable[0];
}
