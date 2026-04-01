/**
 * Thematic profiles for newsletter subscriptions.
 *
 * Each profile defines a persona (natural language description of who the reader is)
 * instead of a keyword list. The AI uses the persona to decide which reforms are
 * relevant, reading the actual legal text diffs.
 */

export interface ThematicProfile {
	id: string;
	name: string;
	description: string;
	icon: string;
	persona: string;
}

export const PROFILES: ThematicProfile[] = [
	{
		id: "sanitario",
		name: "Sanitario",
		description:
			"Profesionales de la salud: médicos, enfermeras, fisioterapeutas, farmacéuticos",
		icon: "\u{1F3E5}",
		persona:
			"Profesional sanitario (médico, enfermera, fisioterapeuta o farmacéutico) que puede tener consulta o clínica propia. Le interesan cambios en requisitos de centros sanitarios, titulaciones profesionales, prestaciones del Sistema Nacional de Salud, formación sanitaria especializada, colegios profesionales sanitarios, y normativa que afecte directamente a su ejercicio profesional o a sus pacientes.",
	},
	{
		id: "autonomos",
		name: "Autónomos y PYMES",
		description: "Freelancers, autónomos y pequeños negocios",
		icon: "\u{1F4BC}",
		persona:
			"Trabajador autónomo o propietario de un pequeño negocio. Le interesan cambios en cotizaciones a la Seguridad Social para autónomos, obligaciones fiscales (IRPF, IVA), regulación laboral de trabajadores por cuenta propia, subvenciones y ayudas específicas para autónomos y PYMES, y normativa mercantil que afecte a pequeñas empresas. NO le interesan becas educativas, normativa sanitaria, ni regulación ambiental salvo que afecte directamente a su actividad.",
	},
	{
		id: "educacion",
		name: "Educación",
		description: "Profesores, formación profesional, universidades",
		icon: "\u{1F4DA}",
		persona:
			"Profesor, formador o profesional del ámbito educativo. Le interesan cambios en currículos, formación profesional, titulaciones, becas y ayudas al estudio, regulación universitaria, requisitos de acceso, y normativa que afecte a centros educativos o a la labor docente.",
	},
	{
		id: "laboral",
		name: "Laboral",
		description: "Trabajadores por cuenta ajena, derechos laborales",
		icon: "\u{2699}\u{FE0F}",
		persona:
			"Trabajador por cuenta ajena o profesional de recursos humanos. Le interesan cambios en contratos de trabajo, despidos, salario mínimo, jornada laboral, seguridad e higiene en el trabajo, prestaciones por desempleo, cotizaciones a la Seguridad Social, y convenios colectivos.",
	},
	{
		id: "vivienda",
		name: "Vivienda",
		description: "Propietarios, inquilinos, compraventa, urbanismo",
		icon: "\u{1F3E0}",
		persona:
			"Propietario, inquilino o profesional inmobiliario. Le interesan cambios en arrendamientos urbanos, propiedad horizontal, hipotecas, urbanismo, vivienda de protección oficial, regulación de alquiler, y normativa que afecte a la compraventa o gestión de inmuebles.",
	},
	{
		id: "medioambiente",
		name: "Medio ambiente y energía",
		description: "Políticas ambientales, energías, sostenibilidad",
		icon: "\u{1F33F}",
		persona:
			"Profesional del sector ambiental o energético. Le interesan cambios en políticas medioambientales, energía eléctrica, gas, residuos, aguas, evaluación de impacto ambiental, energías renovables, y normativa sobre emisiones o sostenibilidad.",
	},
	{
		id: "fiscal",
		name: "Fiscal y tributario",
		description: "Impuestos, hacienda, obligaciones fiscales",
		icon: "\u{1F4CA}",
		persona:
			"Asesor fiscal, contable o contribuyente interesado en fiscalidad. Le interesan cambios en IRPF, Impuesto de Sociedades, IVA, tasas, recaudación, procedimientos tributarios, planes de control de Hacienda, y cualquier normativa que modifique obligaciones fiscales.",
	},
	{
		id: "pensiones",
		name: "Seguridad Social y pensiones",
		description: "Jubilación, prestaciones, cotizaciones",
		icon: "\u{1F6E1}\u{FE0F}",
		persona:
			"Persona próxima a la jubilación, pensionista o profesional de Seguridad Social. Le interesan cambios en pensiones, cotizaciones, prestaciones por incapacidad, jubilación, régimen general de la Seguridad Social, y normativa sobre discapacidad.",
	},
];

export function getProfileById(id: string): ThematicProfile | undefined {
	return PROFILES.find((p) => p.id === id);
}
