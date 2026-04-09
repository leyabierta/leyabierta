/**
 * On-demand citizen article summary generation.
 *
 * When an article has no citizen_summary, generates one via LLM,
 * caches it in the DB, and returns it. Subsequent requests are instant.
 */

import type { Database } from "bun:sqlite";
import { callOpenRouter } from "./openrouter.ts";

const MODEL = "google/gemini-2.5-flash-lite";

const SYSTEM_PROMPT = `Eres un redactor institucional que traduce artículos legales españoles a lenguaje accesible para ciudadanos.

Tono: serio e informativo, como una institución pública que explica derechos y obligaciones. NO uses tono coloquial ni de blog. Evita jerga jurídica, pero mantén la seriedad. Ejemplo: "Tienes derecho a..." es correcto; "Puedes..." es demasiado informal.

- citizen_tags: 3-5 tags en español llano, como buscaría un ciudadano normal.
- citizen_summary: Resumen de máximo 280 caracteres. Lenguaje claro y serio, sin jerga legal. Con acentos correctos. Incluye los datos concretos más relevantes (plazos, requisitos, cantidades) cuando los haya.
Si un artículo es puramente procedimental o técnico, devuelve citizen_tags vacío y citizen_summary vacío.`;

const SCHEMA = {
	name: "article_citizen_metadata",
	schema: {
		type: "object" as const,
		properties: {
			citizen_tags: {
				type: "array" as const,
				items: { type: "string" as const },
			},
			citizen_summary: { type: "string" as const },
		},
		required: ["citizen_tags", "citizen_summary"],
		additionalProperties: false,
	},
};

interface GeneratedSummary {
	citizen_summary: string;
	citizen_tags: string[];
}

export class CitizenSummaryService {
	private apiKey: string | null;
	private stmtGet: ReturnType<Database["prepare"]>;
	private stmtInsertSummary: ReturnType<Database["prepare"]>;
	private stmtInsertTag: ReturnType<Database["prepare"]>;
	private stmtGetTags: ReturnType<Database["prepare"]>;
	// Track in-flight requests to avoid duplicate LLM calls for the same article
	private pending = new Map<string, Promise<GeneratedSummary | null>>();

	constructor(private db: Database) {
		this.apiKey = process.env.OPENROUTER_API_KEY ?? null;

		this.stmtGet = db.prepare(
			"SELECT summary FROM citizen_article_summaries WHERE norm_id = ? AND block_id = ?",
		);
		this.stmtInsertSummary = db.prepare(
			"INSERT OR REPLACE INTO citizen_article_summaries (norm_id, block_id, summary) VALUES (?, ?, ?)",
		);
		this.stmtInsertTag = db.prepare(
			"INSERT OR REPLACE INTO citizen_tags (norm_id, block_id, tag) VALUES (?, ?, ?)",
		);
		this.stmtGetTags = db.prepare(
			"SELECT tag FROM citizen_tags WHERE norm_id = ? AND block_id = ?",
		);
	}

	/**
	 * Get the citizen summary for an article. Returns from cache if available,
	 * otherwise generates on-demand via LLM.
	 */
	async getOrGenerate(
		normId: string,
		blockId: string,
		normTitle: string,
		articleTitle: string,
		articleText: string,
	): Promise<{ citizen_summary: string; citizen_tags: string[] } | null> {
		// 1. Check DB cache
		const cached = this.stmtGet.get(normId, blockId) as {
			summary: string;
		} | null;
		if (cached?.summary) {
			const tags = (
				this.stmtGetTags.all(normId, blockId) as { tag: string }[]
			).map((r) => r.tag);
			return { citizen_summary: cached.summary, citizen_tags: tags };
		}

		// 2. No API key = no generation
		if (!this.apiKey) return null;

		// 3. Skip very short articles (likely procedural)
		if (articleText.length < 50) return null;

		// 4. Deduplicate in-flight requests
		const cacheKey = `${normId}:${blockId}`;
		const inflight = this.pending.get(cacheKey);
		if (inflight) {
			const result = await inflight;
			return result;
		}

		const promise = this.generate(
			normId,
			blockId,
			normTitle,
			articleTitle,
			articleText,
		);
		this.pending.set(cacheKey, promise);

		try {
			const result = await promise;
			return result;
		} finally {
			this.pending.delete(cacheKey);
		}
	}

	private async generate(
		normId: string,
		blockId: string,
		normTitle: string,
		articleTitle: string,
		articleText: string,
	): Promise<GeneratedSummary | null> {
		const userPrompt = `LEY: ${normTitle}\n\nARTÍCULO:\n${articleTitle}\n${articleText.slice(0, 2000)}`;

		try {
			const result = await callOpenRouter<GeneratedSummary>(this.apiKey!, {
				model: MODEL,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: userPrompt },
				],
				temperature: 0.2,
				maxTokens: 500,
				jsonSchema: SCHEMA,
			});

			const { citizen_summary, citizen_tags } = result.data;

			// Persist to DB
			if (citizen_summary) {
				this.stmtInsertSummary.run(normId, blockId, citizen_summary);
				for (const tag of citizen_tags) {
					this.stmtInsertTag.run(normId, blockId, tag);
				}
			}

			return { citizen_summary, citizen_tags };
		} catch (err) {
			console.error(`citizen-summary: failed for ${normId}/${blockId}: ${err}`);
			return null;
		}
	}
}
