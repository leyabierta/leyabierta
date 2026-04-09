/**
 * Hard evaluation questions — designed to find failures.
 *
 * Categories:
 * - cross-law: require connecting multiple laws that aren't obviously related
 * - ambiguous: could mean several things, system must handle gracefully
 * - edge-case: boundary conditions, unusual situations
 * - adversarial: try to trick the system into hallucinating
 * - temporal-hard: need specific version awareness to answer correctly
 */

import type { SpikeQuestion } from "./spike-questions.ts";

export const HARD_QUESTIONS: SpikeQuestion[] = [
	// ── Cross-law (the real test) ──
	{
		id: 101,
		question: "Si me despiden, ¿qué paro me corresponde?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2015-11430", "BOE-A-2015-11724"],
		expectedAnswer:
			"Despido → ET (indemnización, art. 56). Prestación por desempleo → LGSS (requisitos, duración, cuantía). Necesita ambas leyes.",
	},
	{
		id: 102,
		question:
			"Estoy embarazada y mi empresa quiere despedirme. ¿Pueden hacerlo?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2015-11430", "BOE-A-2007-8713"],
		expectedAnswer:
			"Despido nulo por embarazo (ET art. 55.5). Protección adicional por Ley de Igualdad.",
	},
	{
		id: 103,
		question:
			"Soy extranjero con permiso de trabajo. ¿Tengo los mismos derechos laborales que un español?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2000-544", "BOE-A-2015-11430"],
		expectedAnswer:
			"Sí, con permiso de trabajo vigente los derechos laborales son los mismos (Ley Extranjería + ET).",
	},
	{
		id: 104,
		question:
			"Mi jefe me obliga a trabajar los domingos. ¿Es legal? ¿Y si tengo hijos pequeños?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2015-11430"],
		expectedAnswer:
			"Descanso semanal (ET art. 37). Reducción jornada por cuidado hijos (ET art. 37.6). Posible concurrencia.",
	},
	{
		id: 105,
		question:
			"He comprado un piso y tiene vicios ocultos. ¿Qué puedo hacer contra el vendedor y contra el constructor?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2007-20555"],
		expectedAnswer:
			"Garantía legal consumidores (RDL 1/2007). Vicios ocultos compraventa. Responsabilidad del constructor.",
	},

	// ── Ambiguous (multiple valid interpretations) ──
	{
		id: 201,
		question: "¿Cuánto me tienen que pagar?",
		category: "clear",
		expectedNorms: ["BOE-A-2015-11430"],
		expectedAnswer:
			"Pregunta ambigua. El sistema debería pedir más contexto o dar info general sobre salario mínimo / convenio.",
	},
	{
		id: 202,
		question: "¿Puedo grabar a mi jefe sin que lo sepa?",
		category: "cross-law",
		expectedNorms: ["BOE-A-1978-31229"],
		expectedAnswer:
			"Tema complejo que cruza intimidad (CE art. 18), protección datos, y jurisprudencia. El sistema debería ser cauto.",
	},
	{
		id: 203,
		question:
			"¿Es legal que mi empresa lea mis correos del trabajo?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2018-16673", "BOE-A-2015-11430"],
		expectedAnswer:
			"Depende: LOPD + poder de dirección del empresario (ET). Jurisprudencia relevante.",
	},

	// ── Edge cases (unusual situations) ──
	{
		id: 301,
		question:
			"Soy autónomo, trabajo desde casa, y mi casero quiere echarme. ¿El contrato de alquiler protege también mi negocio?",
		category: "cross-law",
		expectedNorms: ["BOE-A-1994-26003", "BOE-A-2007-13409"],
		expectedAnswer:
			"Distinción alquiler vivienda vs local de negocio (LAU). Si es vivienda habitual + actividad profesional, protecciones diferentes.",
	},
	{
		id: 302,
		question:
			"Trabajo a media jornada. ¿Mis vacaciones son también la mitad?",
		category: "clear",
		expectedNorms: ["BOE-A-2015-11430"],
		expectedAnswer:
			"No. Los días de vacaciones son los mismos (30 naturales), lo que cambia es la retribución proporcional.",
	},
	{
		id: 303,
		question:
			"Mi empresa ha cerrado sin pagarme. ¿Quién me paga lo que me deben?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2015-11430", "BOE-A-2015-11724"],
		expectedAnswer:
			"FOGASA (Fondo de Garantía Salarial, ET art. 33) cubre salarios e indemnizaciones pendientes.",
	},
	{
		id: 304,
		question: "¿Puede mi casero entrar en mi piso sin mi permiso?",
		category: "cross-law",
		expectedNorms: ["BOE-A-1978-31229", "BOE-A-1994-26003"],
		expectedAnswer:
			"No. Inviolabilidad del domicilio (CE art. 18.2). El casero no puede entrar sin consentimiento o autorización judicial.",
	},

	// ── Adversarial (designed to cause hallucination) ──
	{
		id: 401,
		question:
			"Según el artículo 847 del Código Laboral, ¿cuántas horas extra puedo hacer?",
		category: "clear",
		expectedNorms: ["BOE-A-2015-11430"],
		expectedAnswer:
			"No existe 'Código Laboral' ni artículo 847. El sistema NO debe inventar. Debe corregir: ET art. 35 regula horas extraordinarias (máx 80/año).",
	},
	{
		id: 402,
		question:
			"He leído que en España los contratos de alquiler duran 3 años. ¿Es cierto?",
		category: "clear",
		expectedNorms: ["BOE-A-1994-26003"],
		expectedAnswer:
			"Incorrecto desde 2019: son 5 años (7 si arrendador es persona jurídica). El sistema debe corregir la premisa falsa del usuario.",
	},
	{
		id: 403,
		question:
			"¿Es verdad que si te despiden el viernes no cobras indemnización?",
		category: "clear",
		expectedNorms: ["BOE-A-2015-11430"],
		expectedAnswer:
			"Falso. No hay ninguna referencia al día de la semana en la legislación sobre despido. El sistema debe desmentir.",
	},
	{
		id: 404,
		question:
			"Dame un resumen de todas las leyes de España sobre impuestos",
		category: "clear",
		expectedNorms: [],
		expectedAnswer:
			"Pregunta demasiado amplia. El sistema debería pedir que concrete o dar una visión muy general citando las principales leyes fiscales.",
	},

	// ── Temporal hard (need version awareness to answer correctly) ──
	{
		id: 501,
		question:
			"¿Ha cambiado algo del permiso de paternidad en los últimos 5 años?",
		category: "clear",
		expectedNorms: ["BOE-A-2015-11430"],
		expectedAnswer:
			"Sí, pasó de 5 semanas a 16 semanas equiparándose con el de maternidad. El sistema debe mostrar la evolución.",
	},
	{
		id: 502,
		question:
			"Si firmé mi contrato de alquiler en 2015, ¿qué ley me aplica, la de antes o la de ahora?",
		category: "clear",
		expectedNorms: ["BOE-A-1994-26003"],
		expectedAnswer:
			"Depende de las disposiciones transitorias. Los contratos firmados antes de la reforma de 2019 se rigen por la ley vigente en el momento de la firma.",
	},
];
