/**
 * Render a law's Markdown body to HTML for the law pages.
 *
 * Shared by `/leyes/[id]/` (which only needs the article anchors, to link its
 * "Artículo por artículo" list into the text page) and `/leyes/[id]/texto/`
 * (which shows the full text). Both must produce identical heading ids, so
 * the heading/id logic lives here and nowhere else.
 */

import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

/**
 * Predictable id for an article heading: "Artículo 90. ..." → "articulo-90",
 * "Artículo 1 bis" → "articulo-1-bis". Mirrors buildArticleAnchor in
 * packages/api/src/services/rag/anchor.ts, which the Q&A citations link to.
 */
export function articleAnchor(text: string): string | null {
	const m = text.match(
		/^Art[ií]culo\s+(\d+(?:\.\d+)?(?:\s*(?:bis|ter|quater|quinquies|sexies|septies))?)/i,
	);
	if (!m) return null;
	return `articulo-${m[1]!.toLowerCase().replace(/\s+/g, "-").replace(/\./g, "-")}`;
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

interface RenderEnv {
	usedIds: Map<string, number>;
}

// Shift all heading levels down by 1 (h1→h2, h2→h3, etc.) so the page has a
// single H1 — the law title rendered in the page header.
const md = new MarkdownIt();
md.renderer.rules.heading_open = (
	tokens,
	idx,
	options,
	env: RenderEnv,
	self,
) => {
	const token = tokens[idx]!;
	const origLevel = Number(token.tag.slice(1));
	token.tag = `h${Math.min(origLevel + 1, 6)}`;
	// Ids for linking. Articles get predictable ids ("articulo-90"); other
	// headings (titles, chapters, disposiciones) get slugified ids. Repeated
	// ids get a numeric suffix ("primera", "primera-2", ...) so every heading
	// is addressable; the first occurrence keeps the bare id, as before.
	if (origLevel >= 2) {
		const text = tokens[idx + 1]?.content;
		if (text) {
			const base = articleAnchor(text) ?? slugify(text);
			if (base) {
				const seen = env.usedIds.get(base) ?? 0;
				env.usedIds.set(base, seen + 1);
				token.attrSet("id", seen === 0 ? base : `${base}-${seen + 1}`);
			}
		}
	}
	return self.renderToken(tokens, idx, options);
};
md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
	const token = tokens[idx]!;
	token.tag = `h${Math.min(Number(token.tag.slice(1)) + 1, 6)}`;
	return self.renderToken(tokens, idx, options);
};

/** Strip the YAML frontmatter from a law file. */
export function lawBody(raw: string): string {
	return raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/)?.[1] ?? raw;
}

/**
 * Markdown → HTML. `sanitize` runs the allow-list pass needed before the HTML
 * is put on a page; callers that only read headings (anchors) can skip it,
 * since it never touches heading text or ids.
 */
export function renderLawHtml(body: string, sanitize = true): string {
	const html = md.render(body, { usedIds: new Map() } satisfies RenderEnv);
	if (!sanitize) return html;
	return sanitizeHtml(html, {
		allowedTags: [
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"p",
			"ul",
			"ol",
			"li",
			"em",
			"strong",
			"a",
			"table",
			"thead",
			"tbody",
			"tr",
			"th",
			"td",
			"blockquote",
			"br",
			"span",
			"div",
			"sup",
			"sub",
			"hr",
			"code",
			"pre",
			"dl",
			"dt",
			"dd",
		],
		allowedAttributes: {
			a: ["href", "title"],
			th: ["colspan", "rowspan"],
			td: ["colspan", "rowspan"],
			span: ["class"],
			div: ["class"],
			h2: ["id"],
			h3: ["id"],
			h4: ["id"],
			h5: ["id"],
			h6: ["id"],
		},
		allowedSchemes: ["https", "http"],
	});
}
