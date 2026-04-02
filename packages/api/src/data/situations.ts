/**
 * Life situations for email alert subscriptions.
 *
 * Each situation maps to a real-life context (e.g. "I rent my home",
 * "I have young children") and links to one or more thematic profiles.
 * The personaFragment is a natural language description that the AI uses
 * to score whether a legislative reform is relevant to this situation.
 */

export interface Situation {
	id: string;
	name: string;
	category: "trabajo" | "familia" | "vivienda" | "salud";
	icon: string;
	personaFragment: string;
	relatedProfiles: string[];
}

export interface SituationCategory {
	id: Situation["category"];
	name: string;
	icon: string;
}

export const SITUATION_CATEGORIES: SituationCategory[] = [
	{ id: "trabajo", name: "Trabajo", icon: "\u{1F4BC}" },
	{
		id: "familia",
		name: "Familia",
		icon: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
	},
	{ id: "vivienda", name: "Vivienda y patrimonio", icon: "\u{1F3E0}" },
	{ id: "salud", name: "Salud y situaci\u00F3n social", icon: "\u{1F3E5}" },
];

export const SITUATIONS: Situation[] = [
	// ── Trabajo ──────────────────────────────────────────────────────────
	{
		id: "trabajo_cuenta_ajena",
		name: "Trabajo por cuenta ajena",
		category: "trabajo",
		icon: "\u{1F9D1}\u{200D}\u{1F4BB}",
		personaFragment:
			"Persona que trabaja por cuenta ajena. Le interesan cambios en contratos, salario m\u00EDnimo, jornada laboral, despidos, cotizaciones a la Seguridad Social, y derechos laborales.",
		relatedProfiles: ["laboral", "fiscal"],
	},
	{
		id: "autonomo",
		name: "Soy aut\u00F3nomo/a",
		category: "trabajo",
		icon: "\u{1F4BC}",
		personaFragment:
			"Trabajador/a aut\u00F3nomo/a o freelance. Le interesan cambios en la cuota de aut\u00F3nomos, cotizaciones por ingresos reales, obligaciones fiscales (IVA, IRPF), tarifa plana, y regulaci\u00F3n del trabajo por cuenta propia.",
		relatedProfiles: ["autonomos", "fiscal"],
	},
	{
		id: "busco_empleo",
		name: "Busco empleo",
		category: "trabajo",
		icon: "\u{1F50D}",
		personaFragment:
			"Persona en situaci\u00F3n de desempleo que busca trabajo activamente. Le interesan cambios en prestaciones por desempleo, pol\u00EDticas activas de empleo, formaci\u00F3n profesional para el empleo, bonificaciones a la contrataci\u00F3n, y programas de inserci\u00F3n laboral.",
		relatedProfiles: ["laboral"],
	},
	{
		id: "empresa_pyme",
		name: "Dirijo una empresa / PYME",
		category: "trabajo",
		icon: "\u{1F3ED}",
		personaFragment:
			"Persona que dirige una empresa o PYME. Le interesan cambios en normativa mercantil, obligaciones fiscales de sociedades, contrataci\u00F3n laboral, prevenci\u00F3n de riesgos laborales, subvenciones a empresas, y regulaci\u00F3n que afecte a la gesti\u00F3n empresarial.",
		relatedProfiles: ["autonomos", "fiscal", "laboral"],
	},

	// ── Familia ─────────────────────────────────────────────────────────
	{
		id: "hijos_menores",
		name: "Tengo hijos menores",
		category: "familia",
		icon: "\u{1F476}",
		personaFragment:
			"Padre o madre con hijos menores de edad. Le interesan cambios en permisos de maternidad y paternidad, deducciones fiscales por hijos, becas y ayudas escolares, regulaci\u00F3n educativa, protecci\u00F3n de menores, y prestaciones familiares de la Seguridad Social.",
		relatedProfiles: ["laboral", "fiscal", "educacion"],
	},
	{
		id: "embarazo_baja",
		name: "Estoy embarazada / baja parental",
		category: "familia",
		icon: "\u{1F930}",
		personaFragment:
			"Persona embarazada o en situaci\u00F3n de baja por nacimiento y cuidado del menor. Le interesan cambios en prestaciones por nacimiento, permisos parentales, protecci\u00F3n frente al despido durante el embarazo, riesgo durante el embarazo, y asistencia sanitaria materno-infantil.",
		relatedProfiles: ["laboral", "sanitario"],
	},
	{
		id: "cuido_dependiente",
		name: "Cuido a un familiar dependiente",
		category: "familia",
		icon: "\u{1F9D3}",
		personaFragment:
			"Persona que cuida a un familiar en situaci\u00F3n de dependencia. Le interesan cambios en la Ley de Dependencia, prestaciones por cuidado de familiares, reducciones de jornada, excedencias por cuidado, deducciones fiscales por dependencia, y regulaci\u00F3n de centros de atenci\u00F3n.",
		relatedProfiles: ["sanitario", "laboral", "fiscal"],
	},
	{
		id: "divorcio",
		name: "Me estoy divorciando / separando",
		category: "familia",
		icon: "\u{2696}\u{FE0F}",
		personaFragment:
			"Persona en proceso de divorcio o separaci\u00F3n. Le interesan cambios en regulaci\u00F3n del divorcio, custodia compartida, pensiones compensatorias, uso de la vivienda familiar, tributaci\u00F3n tras la separaci\u00F3n, y r\u00E9gimen econ\u00F3mico matrimonial.",
		relatedProfiles: ["laboral", "fiscal", "vivienda"],
	},

	// ── Vivienda ────────────────────────────────────────────────────────
	{
		id: "alquilo",
		name: "Alquilo vivienda",
		category: "vivienda",
		icon: "\u{1F3E2}",
		personaFragment:
			"Persona que vive de alquiler. Le interesan cambios en la Ley de Arrendamientos Urbanos, l\u00EDmites al precio del alquiler, fianzas, duraci\u00F3n de contratos, desahucios, y ayudas al alquiler como el bono joven.",
		relatedProfiles: ["vivienda"],
	},
	{
		id: "hipoteca",
		name: "Tengo una hipoteca",
		category: "vivienda",
		icon: "\u{1F3E6}",
		personaFragment:
			"Persona con una hipoteca. Le interesan cambios en regulaci\u00F3n hipotecaria, tipos de inter\u00E9s, cl\u00E1usulas abusivas, Euribor, deducciones fiscales por vivienda habitual, y normativa de protecci\u00F3n de deudores hipotecarios.",
		relatedProfiles: ["vivienda", "fiscal"],
	},
	{
		id: "propietario",
		name: "Soy propietario/a (comunidad de vecinos)",
		category: "vivienda",
		icon: "\u{1F3D8}\u{FE0F}",
		personaFragment:
			"Propietario/a de vivienda en r\u00E9gimen de comunidad. Le interesan cambios en la Ley de Propiedad Horizontal, IBI, derramas, accesibilidad en edificios, eficiencia energ\u00E9tica de viviendas, y obligaciones de los propietarios.",
		relatedProfiles: ["vivienda"],
	},
	{
		id: "compraventa",
		name: "Estoy comprando / vendiendo inmueble",
		category: "vivienda",
		icon: "\u{1F4DD}",
		personaFragment:
			"Persona en proceso de compraventa de un inmueble. Le interesan cambios en el Impuesto de Transmisiones Patrimoniales, plusval\u00EDa municipal, gastos de escritura, regulaci\u00F3n notarial y registral, y deducciones por adquisici\u00F3n de vivienda.",
		relatedProfiles: ["vivienda", "fiscal"],
	},

	// ── Salud y situaci\u00F3n social ───────────────────────────────────────
	{
		id: "sanitario",
		name: "Soy profesional sanitario/a",
		category: "salud",
		icon: "\u{1FA7A}",
		personaFragment:
			"Profesional sanitario/a (m\u00E9dico, enfermera, farmac\u00E9utico, fisioterapeuta). Le interesan cambios en requisitos de centros sanitarios, titulaciones, formaci\u00F3n especializada (MIR/EIR), colegios profesionales, y prestaciones del Sistema Nacional de Salud.",
		relatedProfiles: ["sanitario"],
	},
	{
		id: "discapacidad",
		name: "Tengo una discapacidad reconocida",
		category: "salud",
		icon: "\u{267F}",
		personaFragment:
			"Persona con discapacidad reconocida. Le interesan cambios en grado de discapacidad, prestaciones econ\u00F3micas, deducciones fiscales, accesibilidad, empleo protegido, reserva de plazas, y normativa sobre inclusi\u00F3n y derechos de personas con discapacidad.",
		relatedProfiles: ["laboral", "fiscal", "sanitario"],
	},
	{
		id: "jubilacion",
		name: "Pr\u00F3ximo/a a jubilarme",
		category: "salud",
		icon: "\u{1F3D6}\u{FE0F}",
		personaFragment:
			"Persona pr\u00F3xima a la jubilaci\u00F3n. Le interesan cambios en la edad de jubilaci\u00F3n, c\u00E1lculo de la pensi\u00F3n, jubilaci\u00F3n anticipada, jubilaci\u00F3n activa, complementos a m\u00EDnimos, cotizaciones necesarias, y tributaci\u00F3n de las pensiones.",
		relatedProfiles: ["pensiones", "fiscal"],
	},
	{
		id: "inmigrante",
		name: "Soy inmigrante / tr\u00E1mites de extranjer\u00EDa",
		category: "salud",
		icon: "\u{1F30D}",
		personaFragment:
			"Persona inmigrante o en tr\u00E1mites de extranjer\u00EDa. Le interesan cambios en permisos de residencia y trabajo, reagrupaci\u00F3n familiar, asilo y refugio, nacionalidad, arraigo, y regulaci\u00F3n de la Ley de Extranjer\u00EDa.",
		relatedProfiles: ["laboral"],
	},
	{
		id: "estudiante",
		name: "Soy estudiante",
		category: "salud",
		icon: "\u{1F393}",
		personaFragment:
			"Estudiante universitario/a o de formaci\u00F3n profesional. Le interesan cambios en becas y ayudas al estudio, precios de matr\u00EDcula, acceso a la universidad, formaci\u00F3n profesional, pr\u00E1cticas curriculares, y deducciones fiscales por estudios.",
		relatedProfiles: ["educacion", "fiscal"],
	},
];

export function getSituationsByIds(ids: string[]): Situation[] {
	return SITUATIONS.filter((s) => ids.includes(s.id));
}

export function buildCompositePersona(situations: Situation[]): string {
	return situations.map((s) => s.personaFragment).join(" ");
}
