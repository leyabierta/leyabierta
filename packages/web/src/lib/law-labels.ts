/** Citizen-facing labels shared by the law summary page and the text page. */

export const RANK_LABELS: Record<string, string> = {
	constitucion: "Constitución",
	ley_organica: "Ley Orgánica",
	ley: "Ley",
	real_decreto_ley: "Decreto urgente",
	real_decreto_legislativo: "Decreto legislativo",
	real_decreto: "Real Decreto",
	orden: "Orden",
	decreto: "Decreto",
	circular: "Circular",
	resolucion: "Resolución",
	acuerdo_internacional: "Acuerdo internacional",
	instruccion: "Instrucción",
	reglamento: "Reglamento",
	acuerdo: "Acuerdo",
};

export const STATUS_LABELS: Record<string, string> = {
	vigente: "En vigor",
	derogada: "Ya no está en vigor",
	parcialmente_derogada: "Parcialmente en vigor",
};

const MONTHS = [
	"enero",
	"febrero",
	"marzo",
	"abril",
	"mayo",
	"junio",
	"julio",
	"agosto",
	"septiembre",
	"octubre",
	"noviembre",
	"diciembre",
];

/** "2024-02-17" → "17 de febrero de 2024". */
export function formatDate(iso: string): string {
	if (!iso) return "";
	const [y, m, d] = iso.split("-");
	return `${Number.parseInt(d!, 10)} de ${MONTHS[Number.parseInt(m!, 10) - 1]} de ${y}`;
}

export function capitalize(s: string): string {
	return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/**
 * Official BOE page for a norm (consolidated text), optionally at an article.
 *
 * `blockId` is the BOE `<bloque id>` of the article (our `blocks.block_id`):
 * the BOE HTML uses the same value as the element id ("a14", "art1019",
 * "dadecimosexta", "df"…), so `#<blockId>` lands on the article. Works for
 * regional ids too (DOGC-…, BOJA-…): the BOE hosts their consolidated text.
 */
export function boeUrl(id: string, blockId?: string | null): string {
	const base = `https://www.boe.es/buscar/act.php?id=${encodeURIComponent(id)}`;
	return blockId ? `${base}#${encodeURIComponent(blockId)}` : base;
}

/**
 * Whether to build our own full-text pages (`/leyes/[id]/texto/`). Off by
 * default: they double the static file count and the Workers Free plan caps a
 * deploy at 20,000 assets. With it off, "texto completo" links go to the BOE.
 * Set `BUILD_TEXT_PAGES=true` (e.g. on a paid Workers plan) to bring them back.
 */
export const BUILD_TEXT_PAGES =
	typeof process !== "undefined" && process.env?.BUILD_TEXT_PAGES === "true";

/** Path of our full-text page of a law (only built with BUILD_TEXT_PAGES). */
export function lawTextPath(id: string, anchor?: string | null): string {
	return `/leyes/${id}/texto/${anchor ? `#${anchor}` : ""}`;
}
