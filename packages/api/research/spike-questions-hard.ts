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
		category: "cross-law",
		expectedNorms: ["BOE-A-2015-11430", "BOE-A-2006-20764", "BOE-A-1993-25359"], // ET, IRPF, or Hacienda — any is valid for such an ambiguous question
		expectedAnswer:
			"Pregunta ambigua. El sistema debería pedir más contexto o dar info general sobre salario mínimo / convenio.",
	},
	{
		id: 202,
		question: "¿Puedo grabar a mi jefe sin que lo sepa?",
		category: "cross-law",
		expectedNorms: ["BOE-A-1978-31229", "BOE-A-2018-16673"],
		expectedAnswer:
			"Tema complejo que cruza intimidad (CE art. 18), protección datos (LOPD art. 89), y jurisprudencia. Cualquiera de las dos leyes es respuesta válida.",
	},
	{
		id: 203,
		question: "¿Es legal que mi empresa lea mis correos del trabajo?",
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
		question: "Trabajo a media jornada. ¿Mis vacaciones son también la mitad?",
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
		question: "Dame un resumen de todas las leyes de España sobre impuestos",
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
			"Sí, pasó de 13 días a 19 semanas (2025) equiparándose con el de maternidad. El sistema debe mostrar la evolución.",
	},
	{
		id: 502,
		question:
			"Si firmé mi contrato de alquiler en 2015, ¿qué ley me aplica, la de antes o la de ahora?",
		category: "cross-law",
		expectedNorms: ["BOE-A-1994-26003", "BOE-A-2023-12203"], // LAU + vivienda reform
		expectedAnswer:
			"Depende de las disposiciones transitorias. Los contratos firmados antes de la reforma de 2019 se rigen por la ley vigente en el momento de la firma.",
	},

	// ── Adversarial: completeness & source quality (Benjamín's feedback) ──
	{
		id: 601,
		question:
			"Mi gimnasio fue comprado por otra empresa y me cambiaron el contrato sin mi consentimiento. ¿Es legal?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2007-20555"], // Consumidores
		expectedAnswer:
			"La modificación unilateral del contrato sin consentimiento del consumidor puede ser cláusula abusiva (RDL 1/2007). La subrogación empresarial no permite cambiar condiciones esenciales del contrato.",
	},
	{
		id: 602,
		question:
			"Le pedí a una empresa mis datos personales por email y me dicen que tengo que enviar una carta física. ¿Es legal?",
		category: "clear",
		expectedNorms: ["BOE-A-2018-16673"], // LOPDGDD
		expectedAnswer:
			"No. El ejercicio de derechos RGPD puede hacerse por medios electrónicos. El responsable debe facilitar el ejercicio, no dificultarlo.",
	},
	{
		id: 603,
		question: "¿Cuántas veces se ha reformado la Constitución española?",
		category: "clear",
		expectedNorms: ["BOE-A-1978-31229"], // Constitución
		expectedAnswer:
			"Dos veces: art. 13.2 en 1992 (Tratado de Maastricht) y art. 135 en 2011 (estabilidad presupuestaria). Más recientemente art. 49 en 2024.",
	},
	{
		id: 604,
		question: "Escribe un poema sobre la Constitución",
		category: "out-of-scope",
		expectedNorms: [],
		expectedAnswer:
			"Debe declinar. No es una pregunta legal aunque mencione un concepto legal.",
	},
	{
		id: 605,
		question: "Mi empresa me ha despedido por WhatsApp. ¿Es un despido válido?",
		category: "clear",
		expectedNorms: ["BOE-A-2015-11430"], // ET
		expectedAnswer:
			"El despido debe comunicarse por escrito con carta de despido (ET art. 55). Un WhatsApp podría ser improcedente por defecto de forma.",
	},
	{
		id: 606,
		question: "¿Pueden embargarme la nómina entera si tengo una deuda?",
		category: "cross-law",
		expectedNorms: ["BOE-A-2015-11430"], // ET art. 27 (SMI inembargable)
		expectedAnswer:
			"No. El SMI es inembargable. Por encima del SMI se aplican tramos progresivos. ET art. 27 + LEC arts. 607-609.",
	},
	{
		id: 607,
		question:
			"La ley del artículo 234 bis del Real Decreto 44/2023 sobre criptomonedas establece que Bitcoin es moneda de curso legal en España. ¿Es cierto?",
		category: "clear",
		expectedNorms: [],
		expectedAnswer:
			"Falso. No existe tal artículo ni tal Real Decreto. Bitcoin no es moneda de curso legal en España. El sistema debe corregir la premisa inventada sin afirmar que la norma existe.",
	},
	{
		id: 608,
		question: "¿qe derechos tengo si me echan del curro estando de baja?",
		category: "clear",
		expectedNorms: ["BOE-A-2015-11430"], // ET
		expectedAnswer:
			"Despido durante IT puede ser nulo (discriminación por enfermedad, Ley 15/2022). El sistema debe entender lenguaje coloquial y errores ortográficos.",
	},

	// ── Autonomous community law retrieval (robustness tests) ──
	{
		id: 701,
		question:
			"¿Qué dice la ley de vivienda de las Illes Balears sobre el precio del alquiler?",
		category: "clear",
		expectedNorms: ["BOE-A-2018-9774"], // Ley 5/2018, vivienda Baleares
		expectedAnswer:
			"La Ley 5/2018 de vivienda de las Illes Balears regula aspectos de alquiler en el ámbito balear.",
	},
	{
		id: 702,
		question:
			"¿Cómo regula Cataluña las sucesiones y herencias en su código civil?",
		category: "clear",
		expectedNorms: ["BOE-A-2008-13533"], // Ley 10/2008, libro cuarto CC Cataluña
		expectedAnswer:
			"El libro cuarto del Código Civil de Cataluña (Ley 10/2008) regula las sucesiones.",
	},
	{
		id: 703,
		question:
			"Vivo en Navarra, ¿existe una ley foral sobre derecho a la vivienda?",
		category: "clear",
		expectedNorms: ["BOE-A-2010-8618"], // Ley Foral 10/2010, vivienda Navarra
		expectedAnswer:
			"Sí, la Ley Foral 10/2010 regula el derecho a la vivienda en Navarra.",
	},
	{
		id: 704,
		question:
			"¿Qué ley de servicios sociales se aplica en Andalucía?",
		category: "clear",
		expectedNorms: ["BOE-A-2017-657"], // Ley 9/2016 de Servicios Sociales de Andalucía
		expectedAnswer:
			"En Andalucía se aplica la Ley 9/2016 de Servicios Sociales de Andalucía.",
	},
	{
		id: 705,
		question:
			"¿Las cooperativas en el País Vasco se rigen por la ley estatal o tienen ley propia?",
		category: "clear",
		expectedNorms: ["BOE-A-2020-615"], // Ley 11/2019 de Cooperativas de Euskadi
		expectedAnswer:
			"El País Vasco tiene su propia ley de cooperativas (Ley 11/2019).",
	},
	{
		id: 706,
		question:
			"¿Qué norma regula la ordenación urbanística en Galicia?",
		category: "clear",
		expectedNorms: ["BOE-A-2016-3191"], // Ley 2/2016 del suelo de Galicia
		expectedAnswer:
			"La Ley 2/2016, de 10 de febrero, del suelo de Galicia regula la ordenación urbanística gallega.",
	},
	{
		id: 707,
		question:
			"¿Qué dice el Código Civil catalán sobre la persona y la familia?",
		category: "clear",
		expectedNorms: ["BOE-A-2010-13312"], // Ley 25/2010, libro segundo CC Cataluña
		expectedAnswer:
			"El libro segundo del Código Civil de Cataluña (Ley 25/2010) regula la persona y la familia.",
	},
	{
		id: 708,
		question:
			"¿Qué protección tienen los menores en Andalucía según la legislación autonómica?",
		category: "clear",
		expectedNorms: ["BOE-A-2021-13605"], // Ley 4/2021 de Infancia y Adolescencia de Andalucía
		expectedAnswer:
			"La Ley 4/2021 de Infancia y Adolescencia de Andalucía establece el marco de protección de menores.",
	},
];
