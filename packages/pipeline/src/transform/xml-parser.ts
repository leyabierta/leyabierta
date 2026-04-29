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

// biome-ignore lint/suspicious/noExplicitAny: XML tree nodes have dynamic shape
type XmlNode = Record<string, any>;

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

function extractParagraphs(versionChildren: XmlNode[]): Paragraph[] {
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

// ─── Inline node rendering ───

/**
 * Render an array of inline XML nodes into a Markdown-flavored text string.
 * Handles: #text, strong/b, em/i, a, img, sup, ins, span, br.
 */
function renderInlineNodes(nodes: XmlNode[]): string {
	const parts: string[] = [];

	for (const node of nodes) {
		// Plain text
		if (node["#text"] !== undefined) {
			parts.push(decodeEntities(String(node["#text"])));
			continue;
		}

		// Bold
		if (node.strong || node.b) {
			const inner = renderInlineNodes((node.strong ?? node.b) as XmlNode[]);
			const { leading, content, trailing } = trimInner(inner);
			if (content) {
				parts.push(`${leading}**${content}**${trailing}`);
			}
			continue;
		}

		// Italic
		if (node.em || node.i) {
			const inner = renderInlineNodes((node.em ?? node.i) as XmlNode[]);
			const { leading, content, trailing } = trimInner(inner);
			if (content) {
				parts.push(`${leading}*${content}*${trailing}`);
			}
			continue;
		}

		// Links: strip tag, keep text — except editorial cross-reference chrome
		// (<a class="refPost">, <a class="refAnt">) which BOE injects as a UI
		// affordance pointing at its own viewer; the target norm is already
		// in NormAnalisis.referencias and rendering this text leaks raw anchor
		// fragments like "Ref. BOE-A-XXXX-YYYY#cu" into the article.
		if (node.a) {
			const aClass = (node[":@"]?.class as string) ?? "";
			if (aClass.startsWith("ref")) continue;
			const inner = renderInlineNodes(node.a as XmlNode[]);
			// Defensive: strip any trailing "#anchor" fragment that survived
			// from BOE's link text (some <a> have no class but same shape).
			parts.push(inner.replace(/#\S*$/, ""));
			continue;
		}

		// Images: convert to Markdown
		if (node.img) {
			const attrs = node[":@"] ?? {};
			const src = (attrs.src as string) ?? "";
			const alt = (attrs.alt as string) ?? "imagen";
			parts.push(`![${alt}](${src})`);
			continue;
		}

		// Superscript: unwrap (keep text inline)
		if (node.sup) {
			parts.push(renderInlineNodes(node.sup as XmlNode[]));
			continue;
		}

		// Inserted text (corrections): unwrap
		if (node.ins) {
			parts.push(renderInlineNodes(node.ins as XmlNode[]));
			continue;
		}

		// Spans: unwrap
		if (node.span) {
			parts.push(renderInlineNodes(node.span as XmlNode[]));
			continue;
		}

		// Line breaks
		if (node.br !== undefined) {
			parts.push("\n");
			continue;
		}

		// Any other element: try to render its children
		for (const key of Object.keys(node)) {
			if (key === ":@") continue;
			if (Array.isArray(node[key])) {
				parts.push(renderInlineNodes(node[key] as XmlNode[]));
			}
		}
	}

	return parts.join("");
}

/** Split leading/trailing whitespace from inner content for clean Markdown delimiters. */
function trimInner(text: string): {
	leading: string;
	content: string;
	trailing: string;
} {
	const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
	if (!match) return { leading: "", content: text, trailing: "" };
	return {
		leading: match[1] ?? "",
		content: match[2] ?? "",
		trailing: match[3] ?? "",
	};
}

// ─── Table conversion ───

function tableToMarkdown(tableChildren: XmlNode[]): string {
	const rows: string[][] = [];

	// Find <tr> nodes (may be inside <thead>, <tbody>, <tfoot> or directly)
	const trNodes = collectTrNodes(tableChildren);

	for (const trNode of trNodes) {
		const cells: string[] = [];
		const rowChildren: XmlNode[] = trNode.tr ?? [];

		for (const cell of rowChildren) {
			if (!cell.td && !cell.th) continue;
			const cellChildren: XmlNode[] = (cell.td ?? cell.th) as XmlNode[];
			const text = extractCellText(cellChildren);
			cells.push(text.replaceAll("\n", " ").replaceAll("|", "\\|"));
		}

		if (cells.length > 0) rows.push(cells);
	}

	if (rows.length === 0) return "";

	// Normalize column count
	const maxCols = Math.max(...rows.map((r) => r.length));
	for (const row of rows) {
		while (row.length < maxCols) row.push("");
	}

	// Build markdown table
	const lines: string[] = [];
	lines.push(`| ${rows[0]!.join(" | ")} |`);
	lines.push(`| ${rows[0]!.map(() => "---").join(" | ")} |`);
	for (let i = 1; i < rows.length; i++) {
		lines.push(`| ${rows[i]!.join(" | ")} |`);
	}

	return lines.join("\n");
}

/** Collect all <tr> nodes, including those nested in <thead>/<tbody>/<tfoot>. */
function collectTrNodes(nodes: XmlNode[]): XmlNode[] {
	const result: XmlNode[] = [];
	for (const node of nodes) {
		if (node.tr) {
			result.push(node);
		} else if (node.thead || node.tbody || node.tfoot) {
			const section = (node.thead ?? node.tbody ?? node.tfoot) as XmlNode[];
			result.push(...collectTrNodes(section));
		}
	}
	return result;
}

/** Extract text from table cell children (may contain <p> tags or raw text). */
function extractCellText(children: XmlNode[]): string {
	const parts: string[] = [];
	for (const child of children) {
		if (child["#text"] !== undefined) {
			parts.push(decodeEntities(String(child["#text"])));
		} else if (child.p) {
			parts.push(renderInlineNodes(child.p as XmlNode[]));
		} else {
			// Recurse into any other element
			for (const key of Object.keys(child)) {
				if (key === ":@") continue;
				if (Array.isArray(child[key])) {
					parts.push(extractCellText(child[key] as XmlNode[]));
				}
			}
		}
	}
	return normalizeWhitespace(parts.join(" "));
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

const NAMED_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&nbsp;": " ",
};

/**
 * Decode HTML entities to characters in a single pass (prevents double-decoding).
 *
 * Whitespace is NOT trimmed here: this runs per #text node, and trimming would
 * collapse the space between two adjacent inline elements (e.g. "...2026. " +
 * "<a>Ref...</a>" \u2192 "...2026.Ref..."). Trim happens at the paragraph boundary.
 */
function decodeEntities(text: string): string {
	return text
		.replace(
			/&(?:#x([0-9a-fA-F]+)|#(\d+)|[a-z]+);/gi,
			(match, hex?: string, dec?: string) => {
				if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
				if (dec) return String.fromCharCode(Number.parseInt(dec, 10));
				return NAMED_ENTITIES[match] ?? match;
			},
		)
		.replace(/[\u2002\u2003\u202F\u00A0]/g, " ");
}

/**
 * Collapse whitespace runs and trim \u2014 apply at paragraph/cell boundaries only.
 *
 * The newline rule trims only horizontal whitespace around line breaks, not
 * other newlines: `\s*\n\s*` would have `\s*` consume an adjacent `\n`, which
 * collapses paragraph breaks (`\n\n` \u2192 `\n`). The diff renderer in
 * reforma.astro splits block text on `\n\n` to drive per-paragraph diffs, so
 * losing those breaks would coalesce a multi-paragraph article into one.
 */
function normalizeWhitespace(text: string): string {
	return text
		.replace(/[ \t]+/g, " ")
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.trim();
}
