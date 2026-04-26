/**
 * Build a predictable HTML anchor ID from a block/article title.
 *
 * For articles (e.g. "Artículo 90. Derecho a la intimidad...") returns
 * "articulo-90". For "Artículo 1 bis" returns "articulo-1-bis".
 *
 * This MUST stay in sync with the heading ID logic in
 * packages/web/src/pages/laws/[id].astro — both use the same convention
 * so that citation links land on the correct anchor.
 *
 * Returns "" if the title doesn't look like an article reference.
 */
export function buildArticleAnchor(title: string): string {
	const m = title.match(
		/Art[ií]culo\s+(\d+(?:\.\d+)?(?:\s*(?:bis|ter|quater|quinquies|sexies|septies))?)/i,
	);
	if (!m?.[1]) return "";
	const id = m[1].toLowerCase().replace(/\s+/g, "-").replace(/\./g, "-");
	return `articulo-${id}`;
}
