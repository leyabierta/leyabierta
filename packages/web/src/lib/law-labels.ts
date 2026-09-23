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

/** Official BOE page for a norm (consolidated text). */
export function boeUrl(id: string): string {
	return `https://www.boe.es/buscar/act.php?id=${encodeURIComponent(id)}`;
}

/** Path of the full-text page of a law, optionally at an article anchor. */
export function lawTextPath(id: string, anchor?: string | null): string {
	return `/leyes/${id}/texto/${anchor ? `#${anchor}` : ""}`;
}
