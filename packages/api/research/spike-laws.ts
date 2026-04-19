/**
 * 100 citizen-relevant Spanish laws for the RAG validation spike.
 *
 * Selection criteria:
 * - Vigente (in force)
 * - State-level (country = 'es')
 * - 10-300 articles each (~13,500 articles total)
 * - Sorted by reform count (most amended = most relevant to citizens)
 * - Plus key citizen laws added manually (Constitución, ET, LAU, LGSS, etc.)
 */

/** Top 100 most-reformed state laws with 10-300 articles */
export const SPIKE_LAW_IDS: string[] = [
	// ── Key citizen laws (manually added) ──
	"BOE-A-1978-31229", // Constitución Española (184 arts)
	"BOE-A-2015-11430", // Estatuto de los Trabajadores (141 arts)
	"BOE-A-1994-26003", // LAU - Arrendamientos Urbanos (64 arts)
	"BOE-A-2015-11724", // Ley General de la Seguridad Social (507 arts - big but essential)
	"BOE-A-2015-10565", // Ley Procedimiento Administrativo (156 arts)
	"BOE-A-2015-10566", // Ley Régimen Jurídico Sector Público (219 arts)
	"BOE-A-2018-16673", // Ley Protección de Datos (144 arts)

	// ── Top reformed laws (auto-selected) ──
	"BOE-A-2006-20764", // Ley IRPF (221 arts)
	"BOE-A-1992-28740", // Ley IVA (249 arts)
	"BOE-A-1992-28741", // Ley Impuestos Especiales (140 arts)
	"BOE-A-1993-25359", // RDL Transmisiones Patrimoniales (75 arts)
	"BOE-A-2000-15060", // RDL Infracciones y Sanciones Orden Social (68 arts)
	"BOE-A-2004-4214", // RDL Haciendas Locales (273 arts)
	"BOE-A-2014-12328", // Ley Impuesto de Sociedades (212 arts)
	"BOE-A-1998-16718", // Ley Jurisdicción Contencioso-Administrativa (190 arts)
	"BOE-A-1985-5392", // Ley Bases de Régimen Local (198 arts)
	"BOE-A-1985-11672", // Ley Orgánica Régimen Electoral (252 arts)
	"BOE-A-2007-6820", // Reglamento IRPF (170 arts)
	"BOE-A-1992-28925", // Reglamento IVA (147 arts)
	"BOE-A-1987-12636", // RDL Clases Pasivas del Estado (110 arts)
	"BOE-A-1984-17387", // Ley Medidas Función Pública (79 arts)
	"BOE-A-1998-23284", // Ley Sector Hidrocarburos (198 arts)
	"BOE-A-1991-14463", // Ley IGIC Canarias (138 arts)
	"BOE-A-1997-28053", // Ley Medidas Fiscales 1997 (209 arts)
	"BOE-A-2008-3657", // Ley Suelo (189 arts)
	"BOE-A-1997-25340", // Ley Sector Eléctrico (122 arts)
	"BOE-A-1987-29141", // Ley Impuesto Sucesiones (53 arts)
	"BOE-A-1996-1579", // Reglamento Cotización SS (114 arts)
	"BOE-A-1991-14392", // Ley Impuesto Patrimonio (47 arts)
	"BOE-A-2000-24357", // Ley Medidas Fiscales 2000 (137 arts)
	"BOE-A-2003-21614", // Ley General Presupuestaria (225 arts)
	"BOE-A-2020-4208", // RDL COVID-19 medidas urgentes (95 arts)
	"BOE-A-1994-15794", // Ley Zona Especial Canarias (119 arts)
	"BOE-A-1994-28968", // Ley Medidas Fiscales 1994 (138 arts)
	"BOE-A-1993-13437", // Ley Cooperativas País Vasco (103 arts)
	"BOE-A-2013-13645", // Ley Sector Eléctrico 2013 (133 arts)
	"BOE-A-2004-18911", // RDL Seguro Responsabilidad Civil Vehículos (167 arts)
	"BOE-A-2007-8713", // Ley Igualdad (186 arts)
	"BOE-A-2000-544", // Ley Extranjería (118 arts)
	"BOE-A-1985-12534", // Ley Patrimonio Histórico (100 arts)
	"BOE-A-1994-12554", // Ley ETTs (36 arts)
	"BOE-A-2007-15984", // Reglamento Gestión e Inspección Tributaria (264 arts)
	"BOE-A-2003-20977", // Ley General de Subvenciones (104 arts)
	"BOE-A-1987-17803", // Ley Transportes Terrestres (221 arts)
	"BOE-A-2001-14276", // RDL Ley de Aguas (191 arts)
	"BOE-A-2007-20555", // RDL Consumidores y Usuarios (202 arts)
	"BOE-A-2007-13409", // Ley Autónomos (76 arts)
	"BOE-A-2020-3824", // RDL COVID-19 medidas económicas (68 arts)
	"BOE-A-2001-24965", // Ley Medidas Fiscales 2001 (175 arts)
	"BOE-A-2012-10610", // Ley Estabilidad Presupuestaria (184 arts)
	"BOE-A-1998-30155", // Ley Medidas Fiscales 1998 (186 arts)
	"BOE-A-1996-29117", // Ley Medidas Fiscales 1996 (225 arts)

	// ── Added for hard questions dataset ──
	"BOE-A-2004-21760", // Ley Orgánica Violencia de Género (106 arts)
	"BOE-A-2021-21788", // RDL 32/2021 reforma laboral (30 arts)
	"BOE-A-2023-12203", // Ley 12/2023 derecho a la vivienda

	// ── Added for eval coverage ──
	"BOE-A-2000-323", // LEC - Ley de Enjuiciamiento Civil (916 arts — embargo nómina arts. 607-609)
	"BOE-A-2022-11589", // Ley 15/2022 igualdad de trato y no discriminación (71 arts — nulidad despido por enfermedad)
];

/** Total: ~55+ laws, ~8,500+ articles. Manageable for a spike. */
// Note: Código Civil (2077 arts) and Código Penal (784 arts) intentionally
// excluded to keep embedding costs low. Cross-law questions about
// herencias/penal will test what happens when the answer ISN'T in the dataset.
