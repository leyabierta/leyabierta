/**
 * Article Picker — scoped Alternative Finder.
 *
 * Given a question and a known-good norm (from human ground truth), picks
 * which article(s) within that norm actually answer the question. Used by:
 *
 * 1. The article-level annotation pass over the 114 human seeds (where
 *    `expectedNorms` is human-given but `expectedArticles` is missing).
 * 2. The full Alternative Finder, which calls this once per candidate norm.
 *
 * The LLM gets ALL articles of the norm at once (truncated) and returns the
 * subset that answers, or an empty list if none does. An empty list is a
 * legitimate signal — either the GT norm is wrong or the question is poorly
 * scoped — and we surface those cases for review.
 */

import type { Database } from "bun:sqlite";
import type { NanLlmClient } from "../llm/nan-client.ts";
import type { EvalTrace } from "../llm/tracing.ts";
import type { ExpectedArticle } from "../schema.ts";

export interface NormArticle {
	blockId: string;
	title: string;
	text: string;
}

export function loadNormArticles(
	db: Database,
	normId: string,
	opts: {
		maxArticles?: number;
		minTextLen?: number;
		/**
		 * If given, BM25-rank articles within this norm by relevance to the
		 * query and return the top `maxArticles` instead of position-ordered.
		 * Lifts recall on large norms (Estatuto Trabajadores 60+, Código
		 * Civil 1800+) where the LLM otherwise loses the needle. Falls back
		 * to position-order if FTS returns nothing.
		 */
		query?: string;
	} = {},
): NormArticle[] {
	const { maxArticles = 60, minTextLen = 100, query } = opts;

	// Count first — for small norms (≤50 articles), pass them all so the
	// LLM has the full picture. BM25 prefilter only helps on big norms
	// where the LLM otherwise drowns (Código Civil 1800+, LGSS 380+).
	const total = (
		db
			.prepare(
				`SELECT COUNT(*) AS n FROM blocks
				 WHERE norm_id = ?
				   AND block_type = 'precepto'
				   AND block_id NOT LIKE 'da%'
				   AND block_id NOT LIKE 'df%'
				   AND block_id NOT LIKE 'dt%'
				   AND block_id NOT LIKE 'dd%'
				   AND length(current_text) >= ?`,
			)
			.get(normId, minTextLen) as { n: number }
	).n;
	// Threshold = 50 chosen empirically on the 64 human seeds: ET (60 art),
	// LAU (39), TR-LGSS (380) all see better recall WITH BM25 prefilter.
	// Smaller norms run position-order with maxArticles=60 (everything fits).
	const useBm25 = total > 50 && query && query.trim().length >= 4;

	if (useBm25) {
		const cleaned = query
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9\s]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.split(" ")
			.filter((w) => w.length >= 3)
			.slice(0, 8)
			.join(" OR ");
		if (cleaned) {
			try {
				const ranked = db
					.prepare(
						`SELECT b.block_id, b.title, b.current_text
						 FROM blocks_fts f
						 JOIN blocks b ON b.norm_id = f.norm_id AND b.block_id = f.block_id
						 WHERE f.norm_id = ?
						   AND f.blocks_fts MATCH ?
						   AND b.block_type = 'precepto'
						   AND b.block_id NOT LIKE 'da%'
						   AND b.block_id NOT LIKE 'df%'
						   AND b.block_id NOT LIKE 'dt%'
						   AND b.block_id NOT LIKE 'dd%'
						   AND length(b.current_text) >= ?
						 ORDER BY rank
						 LIMIT ?`,
					)
					.all(normId, cleaned, minTextLen, maxArticles) as Array<{
					block_id: string;
					title: string;
					current_text: string;
				}>;
				if (ranked.length > 0) {
					return ranked.map((r) => ({
						blockId: r.block_id,
						title: r.title,
						text: r.current_text,
					}));
				}
			} catch {
				// FTS error → fall through to position-order
			}
		}
	}

	const rows = db
		.prepare(
			`SELECT block_id, title, current_text
			 FROM blocks
			 WHERE norm_id = ?
			   AND block_type = 'precepto'
			   AND block_id NOT LIKE 'da%'
			   AND block_id NOT LIKE 'df%'
			   AND block_id NOT LIKE 'dt%'
			   AND block_id NOT LIKE 'dd%'
			   AND length(current_text) >= ?
			 ORDER BY position
			 LIMIT ?`,
		)
		.all(normId, minTextLen, maxArticles) as Array<{
		block_id: string;
		title: string;
		current_text: string;
	}>;
	return rows.map((r) => ({
		blockId: r.block_id,
		title: r.title,
		text: r.current_text,
	}));
}

const SYSTEM_PROMPT = `Eres un jurista español. Tu tarea: dada una pregunta de un ciudadano y la lista numerada de artículos de UNA SOLA norma, identifica qué artículo(s) responden sustancialmente a la pregunta.

Reglas:
- "Responde sustancialmente" significa que el artículo contiene la respuesta, no que sea contexto, definición previa, o tema relacionado.
- Si varios artículos responden a partes distintas de la pregunta, devuélvelos todos.
- Marca exactamente UNO como "primary" — el más directo. Los demás van como secundarios.
- Si NINGÚN artículo de la lista responde, devuelve una lista vacía. NO inventes — es una señal legítima.
- Devuelve los blockId tal y como aparecen (ej: "a1", "a38").`;

const JSON_SCHEMA = {
	type: "object",
	properties: {
		picked: {
			type: "array",
			items: {
				type: "object",
				properties: {
					blockId: { type: "string" },
					primary: { type: "boolean" },
					reason: { type: "string", minLength: 5, maxLength: 300 },
				},
				required: ["blockId", "primary", "reason"],
				additionalProperties: false,
			},
		},
	},
	required: ["picked"],
	additionalProperties: false,
} as const;

export interface ArticlePickerResult {
	picked: Array<{ blockId: string; primary: boolean; reason: string }>;
	tookMs: number;
	tokensIn: number;
	tokensOut: number;
}

function buildUserPrompt(question: string, articles: NormArticle[]): string {
	const lines = [`Pregunta: "${question}"`, "", "Artículos disponibles:"];
	for (const a of articles) {
		lines.push(`\n[${a.blockId}] ${a.title}`);
		lines.push(a.text.slice(0, 1200));
	}
	lines.push(
		"",
		"Devuelve JSON con los blockId que responden. Lista vacía si ninguno responde.",
	);
	return lines.join("\n");
}

export async function pickArticles(
	llm: NanLlmClient,
	question: string,
	articles: NormArticle[],
	trace?: EvalTrace,
): Promise<ArticlePickerResult> {
	if (articles.length === 0) {
		return { picked: [], tookMs: 0, tokensIn: 0, tokensOut: 0 };
	}

	const result = await llm.complete<{
		picked: Array<{ blockId: string; primary: boolean; reason: string }>;
	}>({
		systemPrompt: SYSTEM_PROMPT,
		userPrompt: buildUserPrompt(question, articles),
		jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
		jsonSchemaName: "article_picker",
		temperature: 0.1,
		maxTokens: 800,
		trace,
		spanName: "article-picker",
	});

	const valid = new Set(articles.map((a) => a.blockId));
	const filtered = result.value.picked.filter((p) => valid.has(p.blockId));

	let primaryFound = false;
	for (const p of filtered) {
		if (p.primary && !primaryFound) primaryFound = true;
		else if (p.primary) p.primary = false;
	}
	if (!primaryFound && filtered.length > 0) filtered[0]!.primary = true;

	return {
		picked: filtered,
		tookMs: result.tookMs,
		tokensIn: result.tokensIn,
		tokensOut: result.tokensOut,
	};
}

export function pickedToExpectedArticles(
	normId: string,
	picked: ArticlePickerResult["picked"],
): ExpectedArticle[] {
	return picked.map((p) => ({
		norm: normId,
		article: p.blockId,
		primary: p.primary,
	}));
}
