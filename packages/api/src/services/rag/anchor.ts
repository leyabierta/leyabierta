/**
 * Build a predictable HTML anchor ID from a block/article title.
 *
 * For articles (e.g. "Artículo 90. Derecho a la intimidad...") returns
 * "articulo-90". For "Artículo 1 bis" returns "articulo-1-bis".
 *
 * This MUST stay in sync with the heading ID logic in
 * articleAnchor in packages/web/src/lib/law-text.ts (the ids on
 * /leyes/[id]/texto/, only built with BUILD_TEXT_PAGES) — both use the same
 * convention. Citation links on the web now go to the BOE using the
 * citation's `blockId` instead; this anchor is kept for API consumers.
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
