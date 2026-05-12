/**
 * Citation parsing and rendering utilities.
 *
 * This module provides utilities for parsing citation patterns in AI-generated text
 * and rendering them as interactive React components with tooltips.
 */

import MarkdownIt from "markdown-it";
import type { ReactNode } from "react";

const md = new MarkdownIt({ html: false, breaks: true, linkify: false });

/**
 * Citation data structure.
 *
 * Contains information about a cited law and article.
 */
export interface Citation {
	/** Law identifier (e.g., "BOE-A-1978-31229") */
	normId: string;
	/** Law title */
	normTitle: string;
	/** Article title (e.g., "Artículo 1") */
	articleTitle: string;
	/** Predictable HTML anchor ID for deep-linking (e.g., "articulo-90") */
	anchor?: string;
	/** Citizen-friendly summary of the article */
	citizenSummary?: string;
	/** Whether the citation is verified or approximate */
	verified?: boolean;
}

/**
 * Citation pattern regex: [BOE-A-XXXX-XXXX, Artículo N] or similar.
 */
const CITE_PATTERN =
	/\[([A-Z]{2,5}-[A-Za-z]-\d{4}-\d+),\s*(Art(?:ículo|\.)\s*\d+(?:\.\d+)?(?:\s*(?:bis|ter|quater|quinquies|sexies|septies))?[^[\]]*?)\]/g;

/**
 * Build a nested Map for fast citation lookup by norm ID and article title.
 *
 * @param citations - Array of citations to index
 * @returns Nested Map: normId -> articleTitle -> Citation
 */
export function buildCitationMap(
	citations: Citation[],
): Map<string, Map<string, Citation>> {
	const map = new Map<string, Map<string, Citation>>();
	for (const c of citations) {
		if (!map.has(c.normId)) map.set(c.normId, new Map());
		map.get(c.normId)!.set(c.articleTitle.toLowerCase(), c);
	}
	return map;
}

/**
 * Component wrapper for renderTextWithCitations to avoid inline render functions in JSX.
 */
export function TextWithCitations({
	text,
	citationMap,
	keyPrefix,
}: {
	text: string;
	citationMap: Map<string, Map<string, Citation>>;
	keyPrefix: string;
}) {
	const rendered = renderTextWithCitations(text, citationMap, keyPrefix);
	// Single string fragment: return as-is (React handles it fine).
	if (rendered.length === 1 && typeof rendered[0] === "string") {
		return rendered[0];
	}
	return <>{rendered}</>;
}

/**
 * Render a plain text run, splitting out citation matches and replacing them
 * with interactive React links + tooltips. Used both for the markdown path
 * (per text-node) and as a fallback during SSR / pre-hydration.
 *
 * @param text - Text to render
 * @param citationMap - Citation lookup map
 * @param keyPrefix - Key prefix for React elements
 * @returns Array of React nodes with citations converted to links
 */
function renderTextWithCitations(
	text: string,
	citationMap: Map<string, Map<string, Citation>>,
	keyPrefix: string,
): ReactNode[] {
	const parts: ReactNode[] = [];
	let lastIndex = 0;
	let matchIdx = 0;

	for (const match of text.matchAll(CITE_PATTERN)) {
		const start = match.index;
		if (start > lastIndex) {
			parts.push(text.slice(lastIndex, start));
		}

		const normId = match[1]!;
		const articleRef = match[2]!;
		const fullMatch = match[0];
		const citationByArticle = citationMap.get(normId);
		const citation =
			citationByArticle?.get(articleRef.toLowerCase()) ??
			[...(citationByArticle?.values() ?? [])][0];

		if (citation) {
			parts.push(
				<span
					key={`${keyPrefix}-cite-${matchIdx}`}
					className="ask-cite-wrapper"
				>
					<a
						href={`/leyes/${normId}/${citation.anchor ? `#${citation.anchor}` : ""}`}
						target="_blank"
						rel="noopener noreferrer"
						className={`ask-cite-link${citation.verified === false ? " ask-cite-approx" : ""}`}
						title={
							citation.verified === false ? "Referencia aproximada" : undefined
						}
					>
						{articleRef}
						<svg
							className="ask-cite-icon"
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
							<polyline points="15 3 21 3 21 9" />
							<line x1="10" y1="14" x2="21" y2="3" />
						</svg>
					</a>
					<span className="ask-cite-tooltip" role="tooltip">
						<span className="ask-cite-tooltip-norm">
							{citation.normTitle || normId}
						</span>
						<span className="ask-cite-tooltip-article">
							{citation.articleTitle}
						</span>
						{citation.citizenSummary && (
							<span className="ask-cite-tooltip-summary">
								{citation.citizenSummary}
							</span>
						)}
						<span className="ask-cite-tooltip-action">Ver en Ley Abierta</span>
					</span>
				</span>,
			);
		} else {
			parts.push(fullMatch);
		}

		lastIndex = start + fullMatch.length;
		matchIdx++;
	}

	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return parts;
}

/**
 * Convert a DOM node tree (from markdown-it output, parsed via DOMParser) into
 * a React element tree. Text nodes go through `renderTextWithCitations` so the
 * `[BOE-A-XXXX-XXXX, Artículo N]` patterns become tooltipped links even when
 * they appear inside list items, paragraphs, headings, etc.
 *
 * @param node - DOM node to convert
 * @param citationMap - Citation lookup map
 * @param keyPrefix - Key prefix for React elements
 * @returns React element or null
 */
function domToReact(
	node: Node,
	citationMap: Map<string, Map<string, Citation>>,
	keyPrefix: string,
): ReactNode {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.nodeValue ?? "";
		if (!text) return null;
		return (
			<TextWithCitations
				text={text}
				citationMap={citationMap}
				keyPrefix={keyPrefix}
			/>
		);
	}

	if (node.nodeType !== Node.ELEMENT_NODE) return null;

	const el = node as Element;
	const tag = el.tagName.toLowerCase();

	// Skip <script>/<style> defensively (markdown-it shouldn't emit these
	// with `html: false` but belt-and-braces).
	if (tag === "script" || tag === "style") return null;

	const children: ReactNode[] = [];
	for (let i = 0; i < el.childNodes.length; i++) {
		const child = el.childNodes[i];
		if (!child) continue;
		const rendered = domToReact(child, citationMap, `${keyPrefix}-${i}`);
		if (rendered !== null && rendered !== undefined) children.push(rendered);
	}

	const props: Record<string, unknown> = { key: keyPrefix };

	// Carry over href on links (markdown-it can still emit links from auto-
	// detected URLs even with linkify off — be safe).
	if (tag === "a") {
		const href = el.getAttribute("href");
		if (href) {
			props.href = href;
			props.target = "_blank";
			props.rel = "noopener noreferrer";
		}
	}

	// Self-closing tags
	if (tag === "br") return <br key={keyPrefix} />;
	if (tag === "hr") return <hr key={keyPrefix} />;

	// Allow-list of structural tags markdown-it produces. Anything outside
	// this set falls back to <span>.
	const allowed = new Set([
		"p",
		"strong",
		"em",
		"ul",
		"ol",
		"li",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"code",
		"pre",
		"blockquote",
		"a",
		"br",
		"hr",
		"del",
		"s",
		"span",
		"div",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
	]);
	const safeTag = allowed.has(tag) ? tag : "span";

	// biome-ignore lint/suspicious/noExplicitAny: dynamic tag name needs cast for React.createElement equivalent
	const Tag = safeTag as any;
	return (
		<Tag {...props} key={keyPrefix}>
			{children.length > 0 ? children : null}
		</Tag>
	);
}

/**
 * Render markdown with citations converted to interactive React components.
 *
 * @param text - Markdown text to render
 * @param citations - Array of citations to link
 * @returns React node with rendered markdown and interactive citations
 */
export function renderMarkdownWithCitations(
	text: string,
	citations: Citation[],
): ReactNode {
	const citationMap = buildCitationMap(citations);

	// SSR / no DOMParser (shouldn't happen in this island, but be defensive):
	// render as a single paragraph with citation replacement only.
	if (typeof DOMParser === "undefined") {
		return (
			<p className="ask-answer-paragraph">
				<TextWithCitations
					text={text}
					citationMap={citationMap}
					keyPrefix="ssr"
				/>
			</p>
		);
	}

	const html = md.render(text);
	const doc = new DOMParser().parseFromString(
		`<div>${html}</div>`,
		"text/html",
	);
	const root = doc.body.firstElementChild;
	if (!root) return null;

	const children: ReactNode[] = [];
	for (let i = 0; i < root.childNodes.length; i++) {
		const child = root.childNodes[i];
		if (!child) continue;
		const rendered = domToReact(child, citationMap, `md-${i}`);
		if (rendered !== null && rendered !== undefined) children.push(rendered);
	}
	return <>{children}</>;
}
