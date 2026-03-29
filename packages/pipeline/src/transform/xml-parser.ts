/**
 * BOE XML parser.
 *
 * Parses the consolidated text XML from the BOE API into
 * Block/Version/Paragraph structures using fast-xml-parser
 * for robust tree-based parsing instead of fragile regex.
 */

import { XMLParser } from "fast-xml-parser";
import type { Block, Paragraph, Reform, Version } from "../models.ts";

// biome-ignore lint/suspicious/noExplicitAny: XML tree nodes have dynamic shape
type XmlNode = Record<string, any>;

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	preserveOrder: true,
	trimValues: false,
	processEntities: false, // We decode entities ourselves in renderInlineNodes
	stopNodes: ["*.blockquote"], // Skip editorial blockquotes entirely
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
		// Skip blockquotes (stopNodes already prevents deep parsing)
		if (child.blockquote) continue;

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
			const text = renderInlineNodes(child.p as XmlNode[]);

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

		// Links: strip tag, keep text
		if (node.a) {
			const inner = renderInlineNodes(node.a as XmlNode[]);
			parts.push(inner);
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
			cells.push(text.replace(/\n/g, " ").replace(/\|/g, "\\|"));
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
	return parts.join(" ").trim();
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

/**
 * Parse BOE date format (YYYYMMDD) to ISO date (YYYY-MM-DD).
 * Sentinel value 99999999 returns undefined.
 */
function parseBoeDate(raw: string): string | undefined {
	if (!raw || raw === "99999999") return undefined;
	if (raw.includes("-")) return raw;
	if (raw.length === 8) {
		return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
	}
	return undefined;
}

/** Decode HTML entities to characters. */
function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, code: string) =>
			String.fromCharCode(Number.parseInt(code, 10)),
		)
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/[\u2002\u2003\u202F\u00A0]/g, " ")
		.trim();
}
