/**
 * Judge prompts. The panel has 3 judges with explicitly different stances
 * to surface disagreements (which become the borderline queue).
 *
 * - Judge A (qwen3.6, "permissive"): defaults to accept unless clearly broken.
 * - Judge B (gemma4, "balanced"): standard reviewer.
 * - Judge C (qwen3.6, "adversarial"): actively looks for problems.
 *
 * Same JSON schema across all three so the orchestrator can aggregate.
 * Temperature 0.1 (judges should be near-deterministic).
 */

export interface JudgeOutput {
	verdict: "accept" | "reject";
	reason: string;
	concerns: string[]; // even on accept, list nits
}

export const JUDGE_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["accept", "reject"] },
		reason: { type: "string", minLength: 10, maxLength: 400 },
		concerns: { type: "array", items: { type: "string", minLength: 5 } },
	},
	required: ["verdict", "reason", "concerns"],
	additionalProperties: false,
} as const;

const COMMON_RULES = `Criterios de aceptación:
1. La pregunta es realista (alguien la haría de verdad).
2. Los expectedArticles SÍ responden a la pregunta.
3. La pregunta no filtra el ID, nombre de ley ni número de artículo.
4. La voz es coherente con el registro (citizen / formal).
5. La pregunta no es ambigua hasta el punto de admitir respuestas de áreas distintas (p.ej. "qué hago si no me pagan" sin contexto).`;

// ── Judge A: permissive ───────────────────────────────────────────────────

export const JUDGE_PERMISSIVE_PROMPT_ID = "judge-permissive-v1";
export const JUDGE_PERMISSIVE_SYSTEM = `Eres un revisor benevolente de un dataset de evaluación de búsqueda jurídica. Tu sesgo es ACEPTAR siempre que la pregunta sea razonable y los artículos esperados respondan, aunque tenga pequeñas imperfecciones.

${COMMON_RULES}

Solo rechaza si hay un problema claro: respuesta incorrecta, leak grave, o pregunta sin sentido. La perfección no es el listón.`;

// ── Judge B: balanced ─────────────────────────────────────────────────────

export const JUDGE_BALANCED_PROMPT_ID = "judge-balanced-v1";
export const JUDGE_BALANCED_SYSTEM = `Eres un revisor estándar de un dataset de evaluación. Aplicas los criterios sin sesgo a favor ni en contra.

${COMMON_RULES}

Una pregunta entra si todos los criterios se cumplen razonablemente. Una pregunta no entra si alguno falla de forma significativa.`;

// ── Judge C: adversarial ──────────────────────────────────────────────────

export const JUDGE_ADVERSARIAL_PROMPT_ID = "judge-adversarial-v1";
export const JUDGE_ADVERSARIAL_SYSTEM = `Eres un revisor adversarial. Tu trabajo es ENCONTRAR problemas. Por defecto rechazas; solo aceptas si no encuentras ningún defecto significativo.

${COMMON_RULES}

Busca específicamente:
- Ambigüedad que permita múltiples áreas legales como respuesta legítima.
- Leak sutil que el detector automático puede haberse perdido.
- Desajuste de registro: voz citizen con tecnicismo escondido, o voz formal que se cuela como "según el art X".
- Pregunta que es realmente N preguntas mezcladas.
- expectedArticles que solo es contexto, no respuesta sustantiva.

Sé exigente. El usuario quiere un dataset limpio, no un dataset grande.`;

export function judgeUserPrompt(opts: {
	question: string;
	voice: "citizen" | "formal";
	expectedArticles: Array<{ norm: string; article: string; primary: boolean }>;
	articleTexts: Array<{
		norm: string;
		article: string;
		title: string;
		text: string;
	}>;
}): string {
	const lines = [
		`Pregunta: "${opts.question}"`,
		`Voz declarada: ${opts.voice}`,
		"",
		"Artículos esperados (deben responder):",
	];
	for (const a of opts.expectedArticles) {
		const text = opts.articleTexts.find(
			(t) => t.norm === a.norm && t.article === a.article,
		);
		lines.push(
			`- ${a.norm} / ${a.article} ${a.primary ? "(primario)" : "(alternativo)"}`,
		);
		if (text) {
			lines.push(`  ${text.title}`);
			lines.push(`  ${text.text.slice(0, 1500)}`);
		}
		lines.push("");
	}
	lines.push("¿Aceptas esta entrada en el dataset? Responde JSON.");
	return lines.join("\n");
}
