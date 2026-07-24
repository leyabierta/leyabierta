/**
 * Shared inline-node rendering for BOE XML text.
 *
 * Both the consolidated parser (`xml-parser.ts`, `<bloque><version><p>`) and
 * the diario parser (`diario-xml-parser.ts`, flat `<texto><p>`) render the
 * same inline markup — <em>, <strong>, <a>, <table>, entities — into
 * Markdown-flavored text. This module holds that shared logic so both
 * parsers stay in sync instead of drifting.
 */

// biome-ignore lint/suspicious/noExplicitAny: XML tree nodes have dynamic shape
export type XmlNode = Record<string, any>;

/**
 * Render an array of inline XML nodes into a Markdown-flavored text string.
 * Handles: #text, strong/b, em/i, a, img, sup, ins, span, br.
 */
export function renderInlineNodes(nodes: XmlNode[]): string {
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

export function tableToMarkdown(tableChildren: XmlNode[]): string {
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

// ─── Entities and whitespace ───

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
 * "<a>Ref...</a>" → "...2026.Ref..."). Trim happens at the paragraph boundary.
 */
export function decodeEntities(text: string): string {
	return text
		.replace(
			/&(?:#x([0-9a-fA-F]+)|#(\d+)|[a-z]+);/gi,
			(match, hex?: string, dec?: string) => {
				if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
				if (dec) return String.fromCharCode(Number.parseInt(dec, 10));
				return NAMED_ENTITIES[match] ?? match;
			},
		)
		.replace(/[    ]/g, " ");
}

/**
 * Collapse whitespace runs and trim — apply at paragraph/cell boundaries only.
 *
 * The newline rule trims only horizontal whitespace around line breaks, not
 * other newlines: `\s*\n\s*` would have `\s*` consume an adjacent `\n`, which
 * collapses paragraph breaks (`\n\n` → `\n`). The diff renderer in
 * reforma.astro splits block text on `\n\n` to drive per-paragraph diffs, so
 * losing those breaks would coalesce a multi-paragraph article into one.
 */
export function normalizeWhitespace(text: string): string {
	return text
		.replace(/[ \t]+/g, " ")
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.trim();
}
