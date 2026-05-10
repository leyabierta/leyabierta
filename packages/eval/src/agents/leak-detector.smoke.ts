/**
 * Smoke test: verify `detectBigramOverlap` flags the leaks identified in
 * the 2026-05-10 pilot 50 review (§5.2 / §6.2) AND the 7 stopword-bridge
 * leaks found in the pilot 100 review (REVIEW-PILOT100-2026-05-10 §5.1).
 *
 * Run with: `bun run packages/eval/src/agents/leak-detector.smoke.ts`
 */

import { detectBigramOverlap } from "./prompts/leak-detector.ts";

const cases: Array<{ id: string; question: string; article: string }> = [
	{
		id: "q_16480dd7",
		question:
			"¿Cómo debe la organización de productores repartir el importe recuperado por la baja de un socio en sus inversiones subvencionadas?",
		article:
			"Cuando se produzca la baja de un socio, la organización de productores destinará el importe recuperado a las inversiones subvencionadas en curso, conforme al programa operativo aprobado.",
	},
	{
		id: "q_2c95d982",
		question:
			"¿Qué requisitos tienen las investigaciones clínicas y epidemiológicas con datos personales?",
		article:
			"Los estudios de investigación clínica, epidemiológica y de salud pública con datos personales requerirán el consentimiento informado del interesado, salvo las excepciones previstas en la ley.",
	},
	{
		id: "q_1c1a5aac",
		question:
			"¿Quién hace la preselección y la selección final cuando los Servicios Públicos de Empleo intermedian en una oferta?",
		article:
			"Los Servicios Públicos de Empleo realizarán la preselección de candidatos remitiendo a la empresa los perfiles más adecuados; la selección final corresponderá al empleador.",
	},
	{
		id: "q_0a9d0500",
		question:
			"¿Quién se encarga de enviar las peticiones aprobadas a otras autoridades competentes?",
		article:
			"Son funciones del órgano: a) Recibir las solicitudes presentadas. b) Remitir a las distintas autoridades competentes las peticiones aprobadas para su tramitación.",
	},
	{
		id: "q_c31eae79",
		question:
			"¿Cómo se aplica la actualización de precios para contratos firmados antes de 2021?",
		article:
			"La actualización de precios prevista en el artículo 13 bis se aplicará a los contratos formalizados antes de 2021 conforme al índice de garantía de competitividad.",
	},
	// ── Pilot 100 stopword-bridge leaks (REVIEW-PILOT100 §5.1) ────────
	{
		id: "q_e756e899",
		question:
			"¿Qué destino debe darse a los recursos del Fondo de mejora de barrios cuando se trata de zonas degradadas?",
		article:
			"El Fondo de mejora de barrios financiará actuaciones en zonas degradadas, con criterios de prioridad establecidos por la Generalitat.",
	},
	{
		id: "q_53184b45",
		question:
			"¿Cuál es la cuantía de la garantía provisional exigida en un concurso de urbanización privada?",
		article:
			"En todo concurso de urbanización privada el promotor deberá depositar una garantía provisional equivalente al 2% del presupuesto de las obras.",
	},
	{
		id: "q_de6c334d",
		question:
			"¿Cómo se calcula el impuesto en una zona consolidada con servicios y dotaciones suficientes?",
		article:
			"A efectos de la liquidación, se considerará zona consolidada aquella en la que existan servicios y dotaciones suficientes según el planeamiento vigente.",
	},
	{
		id: "q_77759121",
		question:
			"¿Qué pasa con las cuentas de la comarca antes de que el pleno las apruebe?",
		article:
			"Las cuentas de la comarca se someterán al pleno antes del 1 de junio; mientras el pleno no las apruebe, permanecerán en exposición pública.",
	},
	{
		id: "q_a154014a",
		question:
			"¿Cómo se coordinan la administración periférica y los ministerios competentes?",
		article:
			"La administración periférica del Estado dependerá orgánicamente de los ministerios competentes en cada materia, conforme a los reales decretos de estructura.",
	},
	{
		id: "q_62a7f612",
		question:
			"¿Qué medidas de movilidad territorial y transporte colectivo se adoptan para garantizar la sostenibilidad y accesibilidad?",
		article:
			"Los planes de movilidad territorial incorporarán medidas de transporte colectivo orientadas a la sostenibilidad y accesibilidad de los núcleos rurales.",
	},
	{
		id: "q_784d0693",
		question:
			"¿Cómo funciona la cuenta única para garantizar la trazabilidad del expediente judicial?",
		article:
			"Se establece una cuenta única de depósitos y consignaciones que permitirá la trazabilidad del expediente judicial en todas sus fases.",
	},
];

let allCaught = true;
const missed: string[] = [];
for (const c of cases) {
	const result = detectBigramOverlap(c.question, c.article);
	const caught = result !== null;
	if (!caught) {
		allCaught = false;
		missed.push(c.id);
	}
	console.log(
		`${c.id}: ${caught ? "FLAGGED" : "MISSED  "} ${
			result ? `→ ${result.matched.map((b) => `"${b}"`).join(", ")}` : ""
		}`,
	);
}

console.log(
	`\nResult: ${allCaught ? `all ${cases.length} leaks caught` : `${missed.length} missed: ${missed.join(", ")}`}`,
);
process.exit(allCaught ? 0 : 1);
