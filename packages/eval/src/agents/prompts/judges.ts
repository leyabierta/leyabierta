/**
 * Judge prompts. The panel has 3 judges with explicitly different stances
 * to surface disagreements (which become the borderline queue).
 *
 * - Judge A (qwen3.6, "permissive"): defaults to accept unless clearly broken.
 * - Judge B (gemma4, "balanced"): standard reviewer.
 * - Judge C (qwen3.6, "adversarial"): actively looks for SUBSTANTIVE problems.
 *
 * Same JSON schema across all three so the orchestrator can aggregate.
 * Temperature 0.1 (judges should be near-deterministic).
 *
 * v2: concerns are typed so the panel can apply Fix A — any `major`
 * concern of type `leak` / `answer-fit` / `ambiguity` from a rejecting
 * judge requires unanimity to accept (else → borderline for human review).
 */

export type JudgeConcernType =
	| "leak"
	| "answer-fit"
	| "voice"
	| "specificity"
	| "ambiguity";

export type JudgeConcernSeverity = "minor" | "major";

export interface JudgeConcern {
	type: JudgeConcernType;
	severity: JudgeConcernSeverity;
	text: string;
}

export interface JudgeOutput {
	verdict: "accept" | "reject";
	reason: string;
	concerns: JudgeConcern[];
}

export const JUDGE_JSON_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["accept", "reject"] },
		reason: { type: "string", minLength: 10, maxLength: 400 },
		concerns: {
			type: "array",
			items: {
				type: "object",
				properties: {
					type: {
						type: "string",
						enum: ["leak", "answer-fit", "voice", "specificity", "ambiguity"],
					},
					severity: { type: "string", enum: ["minor", "major"] },
					text: { type: "string", minLength: 5 },
				},
				required: ["type", "severity", "text"],
				additionalProperties: false,
			},
		},
	},
	required: ["verdict", "reason", "concerns"],
	additionalProperties: false,
} as const;

const COMMON_RULES = `Criterios de aceptación:
1. La pregunta es realista (alguien la haría de verdad).
2. Los expectedArticles SÍ responden a la pregunta.
3. La pregunta no filtra el ID, nombre de ley ni número de artículo.
4. La voz es coherente con el registro (citizen / formal).
5. La pregunta no es ambigua hasta el punto de admitir respuestas de áreas distintas (p.ej. "qué hago si no me pagan" sin contexto).

Cada concern debe llevar tipo + severidad:
- "leak": la pregunta menciona el ID, número de artículo, nombre exacto de la ley, o filtra términos técnicos distintivos del artículo (≥2 palabras técnicas raras que aparecen literalmente en el artículo).
- "answer-fit": el/los artículo(s) esperado(s) NO responden sustancialmente, o solo dan contexto.
- "voice": registro incorrecto (citizen suena a abogado, o formal incoherente).
- "specificity": vaga o ambigua de forma menor.
- "ambiguity": admite respuestas legítimas de áreas legales totalmente distintas.

Severidad:
- "major" → bloquea aceptar (el problema es real y descalificante).
- "minor" → nit cosmético (lo señalas pero no impide entrar al dataset).

Si rechazas, marca al menos UNA concern con severity="major" del tipo correspondiente (leak / answer-fit / ambiguity / voice / specificity).`;

// ── Judge A: permissive ───────────────────────────────────────────────────

export const JUDGE_PERMISSIVE_PROMPT_ID = "judge-permissive-v2";
export const JUDGE_PERMISSIVE_SYSTEM = `Eres un revisor benevolente de un dataset de evaluación de búsqueda jurídica. Tu sesgo es ACEPTAR siempre que la pregunta sea razonable y los artículos esperados respondan, aunque tenga pequeñas imperfecciones.

${COMMON_RULES}

Solo rechaza si hay un problema claro: respuesta incorrecta, leak grave, o pregunta sin sentido. La perfección no es el listón.`;

// ── Judge B: balanced ─────────────────────────────────────────────────────

export const JUDGE_BALANCED_PROMPT_ID = "judge-balanced-v2";
export const JUDGE_BALANCED_SYSTEM = `Eres un revisor estándar de un dataset de evaluación. Aplicas los criterios sin sesgo a favor ni en contra.

${COMMON_RULES}

Una pregunta entra si todos los criterios se cumplen razonablemente. Una pregunta no entra si alguno falla de forma significativa.`;

// ── Judge C: adversarial ──────────────────────────────────────────────────

export const JUDGE_ADVERSARIAL_PROMPT_ID = "judge-adversarial-v2";
export const JUDGE_ADVERSARIAL_SYSTEM = `Eres un revisor adversarial. Tu trabajo es ENCONTRAR problemas reales (no nits cosméticos). Aceptas si los defectos que encuentras son menores; rechazas SOLO si encuentras: (a) leak sustantivo de terminología única del artículo, (b) respuesta incorrecta o tangencial (los artículos esperados no responden de verdad), o (c) ambigüedad que admite respuestas legítimas de áreas legales distintas. No rechaces por "podría ser más específico" ni por matices estilísticos.

${COMMON_RULES}

Cuando rechaces, marca al menos UNA concern con severity="major" del tipo correspondiente (leak / answer-fit / ambiguity). Si solo encuentras nits, acepta y márcalos como severity="minor".`;

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
