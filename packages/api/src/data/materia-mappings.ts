/**
 * Materia mappings for the life questionnaire onboarding.
 * Each answer maps to exact BOE materia strings from the materias table.
 *
 * SECTOR_MATERIAS is imported from the shared JSON (single source of truth).
 * Other mappings (work status, housing, family, extras) stay here because
 * they're small, logic-coupled, and don't need the exhaustive categorization.
 */

import sectorData from "../../../../packages/shared/data/sector-materias.json";

/** Universal materias assigned to every user */
export const BASE_MATERIAS: string[] = [
	"Impuesto sobre la Renta de las Personas Físicas",
	"Seguridad Social",
	"Consumidores y usuarios",
	"Derechos de los ciudadanos",
];

/** Step 1: work status (single select) */
export const WORK_STATUS_MATERIAS: Record<string, string[]> = {
	cuenta_ajena: [
		"Trabajadores",
		"Contratos de trabajo",
		"Empleo",
		"Estatuto de los Trabajadores",
		"Jornada laboral",
		"Desempleo",
		"Cotización a la Seguridad Social",
	],
	autonomo: [
		"Trabajadores autónomos",
		"Impuesto sobre el Valor Añadido",
		"Cotización a la Seguridad Social",
		"Empresas",
	],
	empresa: [
		"Empresas",
		"Impuesto sobre Sociedades",
		"Impuesto sobre el Valor Añadido",
		"Contratación administrativa",
		"Seguridad e higiene en el trabajo",
		"Cotización a la Seguridad Social",
	],
	jubilado: [
		"Pensiones",
		"Jubilación",
		"Tercera Edad",
		"Clases Pasivas",
		"Regímenes especiales de la Seguridad Social",
	],
	busco_empleo: ["Desempleo", "Subsidio de desempleo", "Formación profesional"],
	estudiante: [
		"Educación",
		"Becas",
		"Universidades",
		"Enseñanza",
		"Formación profesional",
		"Enseñanza de Formación Profesional",
	],
	no_trabajo: [],
};

/** Step 2: sector (single select, conditional) — imported from shared JSON */
export const SECTOR_MATERIAS: Record<string, string[]> = Object.fromEntries(
	Object.entries(sectorData.sectors).map(([key, val]) => [key, val.materias]),
);

/** Work statuses that skip the sector question */
export const SKIP_SECTOR_STATUSES = ["jubilado", "estudiante", "no_trabajo"];

/** Step 3: housing (single select) */
export const HOUSING_MATERIAS: Record<string, string[]> = {
	alquilo: ["Arrendamientos urbanos", "Viviendas"],
	hipoteca: ["Hipoteca", "Viviendas", "Entidades de crédito", "Préstamos"],
	propietario: [
		"Viviendas",
		"Propiedad Horizontal",
		"Impuesto sobre Bienes Inmuebles",
		"Bienes inmuebles",
	],
	familiares: [],
};

/** Step 5: family (multi-select) */
export const FAMILY_MATERIAS: Record<string, string[]> = {
	hijos_menores: ["Menores", "Familia", "Becas", "Centros de enseñanza"],
	dependiente: [
		"Discapacidad",
		"Asistencia social",
		"Tercera Edad",
		"Familia",
		"Invalidez",
	],
	embarazo_baja: ["Familia", "Incapacidades laborales"],
};

/** Step 6: extras (multi-select, optional) */
export const EXTRAS_MATERIAS: Record<string, string[]> = {
	coche: [
		"Vehículos de motor",
		"Circulación vial",
		"Seguridad vial",
		"Seguros de vehículos de motor",
		"Permisos de conducción",
	],
	inversiones: [
		"Mercado de Valores",
		"Impuesto sobre el Patrimonio",
		"Instituciones de Inversión Colectiva",
		"Fondos de inversión",
	],
	mascotas: ["Animales de compañía", "Sanidad veterinaria"],
	casero: ["Arrendamientos urbanos", "Impuesto sobre Bienes Inmuebles"],
	divorcio: ["Familia", "Enjuiciamiento Civil", "Registro Civil", "Matrimonio"],
	discapacidad: [
		"Discapacidad",
		"Barreras arquitectónicas",
		"Asistencia social",
		"Invalidez",
	],
	extranjeria: [
		"Extranjeros",
		"Libre circulación de personas",
		"Nacionalidad",
		"Inmigración",
	],
	ecommerce: [
		"Comercio electrónico",
		"Comercialización",
		"Internet",
		"Impuesto sobre el Valor Añadido",
		"Facturas",
	],
	herencia: ["Impuesto sobre Sucesiones y Donaciones", "Herencias"],
	medioambiente: [
		"Políticas de medio ambiente",
		"Medio ambiente",
		"Contaminación atmosférica",
		"Cambio climático",
		"Energía eléctrica",
	],
	deporte: ["Deporte", "Asociaciones deportivas", "Dopaje"],
};

export interface OnboardingAnswers {
	workStatus: string;
	sector: string | null;
	housing: string;
	family: string[];
	extras: string[];
}

/** Compute unique materias from onboarding answers */
export function computeMaterias(answers: OnboardingAnswers): string[] {
	const set = new Set<string>(BASE_MATERIAS);

	for (const m of WORK_STATUS_MATERIAS[answers.workStatus] ?? []) set.add(m);

	if (answers.sector) {
		for (const m of SECTOR_MATERIAS[answers.sector] ?? []) set.add(m);
	}

	for (const m of HOUSING_MATERIAS[answers.housing] ?? []) set.add(m);

	for (const key of answers.family) {
		for (const m of FAMILY_MATERIAS[key] ?? []) set.add(m);
	}

	for (const key of answers.extras) {
		for (const m of EXTRAS_MATERIAS[key] ?? []) set.add(m);
	}

	return [...set];
}
