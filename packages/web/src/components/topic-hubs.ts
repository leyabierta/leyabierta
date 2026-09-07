/**
 * The topic hubs, as data, so every page that links to one agrees on its name.
 *
 * The hubs were deployed on 2026-08-21 (#149) and, until this file existed, no
 * page on the site linked to them: a grep for "/temas/" over packages/web/src
 * matched only the hub pages themselves and the sitemap list. A page announced
 * by sitemap alone and reached by no internal link is the textbook shape of
 * "Descubierta: actualmente sin indexar", which is where they sat.
 *
 * `lawIds` is the curated membership each hub page already renders. It lives
 * here so the law detail page can emit the reciprocal link (ley → hub) without
 * re-deriving the grouping and drifting from what the hub actually lists.
 *
 * Adding a hub: add it here, add its route to SECONDARY_PAGES in
 * src/lib/site-pages.ts (the sitemap-coverage test enforces that), and create
 * the page under src/pages/temas/.
 */

export interface TopicHub {
	/** Route, with the trailing slash the canonical URLs use. */
	path: string;
	/** Nav/link label — short, the way a citizen would name the topic. */
	label: string;
	/** One line of what the hub covers, shown under the label on the home. */
	blurb: string;
	/** Wording for the reciprocal link on a member law's page. */
	backlinkLabel: string;
	/**
	 * BOE ids the hub curates. Kept in sync with the GROUPS arrays in the hub
	 * pages; a law not in the corpus is dropped there, and the backlink here is
	 * only rendered for a law that is actually on the page.
	 */
	lawIds: string[];
}

export const TOPIC_HUBS: TopicHub[] = [
	{
		path: "/temas/empleo/",
		label: "Trabajo y empleo",
		blurb:
			"El Estatuto de los Trabajadores, la Ley de Empleo, la Seguridad Social y la prevención de riesgos.",
		backlinkLabel: "Legislación laboral y de empleo",
		lawIds: [
			"BOE-A-2015-11430", // RDLeg 2/2015 — Estatuto de los Trabajadores
			"BOE-A-2023-5365", //  Ley 3/2023 — de Empleo
			"BOE-A-2007-13409", // Ley 20/2007 — Estatuto del trabajo autónomo
			"BOE-A-1985-16660", // LO 11/1985 — Libertad sindical
			"BOE-A-2015-11724", // RDLeg 8/2015 — Ley General de la Seguridad Social
			"BOE-A-2015-11719", // RDLeg 5/2015 — Estatuto Básico del Empleado Público
			"BOE-A-1995-24292", // Ley 31/1995 — Prevención de riesgos laborales
			"BOE-A-2000-15060", // RDLeg 5/2000 — Infracciones y sanciones en el orden social
			"BOE-A-2011-15936", // Ley 36/2011 — Jurisdicción social
		],
	},
	{
		path: "/temas/fiscalidad/",
		label: "Impuestos y fiscalidad",
		blurb:
			"El IRPF, el IVA, el Impuesto de Sociedades y la Ley General Tributaria.",
		backlinkLabel: "Legislación fiscal y tributaria",
		lawIds: [
			"BOE-A-1992-28740", // Ley 37/1992 — IVA
			"BOE-A-2006-20764", // Ley 35/2006 — IRPF
			"BOE-A-2014-12328", // Ley 27/2014 — Impuesto sobre Sociedades
			"BOE-A-1992-28741", // Ley 38/1992 — Impuestos Especiales
			"BOE-A-2004-4527", //  RDLeg 5/2004 — IRNR
			"BOE-A-1991-14392", // Ley 19/1991 — Patrimonio
			"BOE-A-1987-28141", // Ley 29/1987 — Sucesiones y Donaciones
			"BOE-A-1993-25359", // RDLeg 1/1993 — ITP y AJD
			"BOE-A-2003-23186", // Ley 58/2003 — General Tributaria
		],
	},
];

/** The hubs a given norm belongs to, in hub order. Empty for most norms. */
export function hubsForLaw(identificador: string): TopicHub[] {
	return TOPIC_HUBS.filter((h) => h.lawIds.includes(identificador));
}
