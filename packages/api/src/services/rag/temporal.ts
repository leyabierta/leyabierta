/**
 * Temporal resolution for RAG.
 *
 * Enriches retrieved articles with version history from the `versions` table.
 * When an article has been modified over time, includes the historical context
 * in the evidence packet so the LLM can explain how the law changed.
 */

import type { Database } from "bun:sqlite";

export interface ArticleVersion {
	date: string;
	sourceId: string;
	text: string;
}

export interface TemporalContext {
	normId: string;
	blockId: string;
	blockTitle: string;
	currentText: string;
	versions: ArticleVersion[];
	hasChanges: boolean;
	/** Summary of changes for the evidence packet */
	changeSummary: string;
}

/**
 * Enrich articles with temporal context.
 * For each article, checks if it has multiple versions and builds a change summary.
 */
export function enrichWithTemporalContext(
	db: Database,
	articles: Array<{
		normId: string;
		blockId: string;
		blockTitle: string;
		text: string;
	}>,
): TemporalContext[] {
	return articles.map((article) => {
		const versions = db
			.query<
				{ date: string; source_id: string; text: string },
				[string, string]
			>(
				`SELECT date, source_id, text FROM versions
         WHERE norm_id = ? AND block_id = ?
         ORDER BY date ASC`,
			)
			.all(article.normId, article.blockId);

		const hasChanges = versions.length > 1;

		let changeSummary = "";
		if (hasChanges) {
			const firstVersion = versions[0];
			const lastVersion = versions[versions.length - 1];
			changeSummary =
				`[HISTORIAL: Este artículo ha sido modificado ${versions.length - 1} veces. ` +
				`Versión original: ${firstVersion.date} (${firstVersion.source_id}). ` +
				`Última modificación: ${lastVersion.date} (${lastVersion.source_id}).]\n\n`;

			// Include the first and last version texts for comparison
			if (versions.length <= 3) {
				// If few versions, include all
				for (const v of versions) {
					changeSummary += `--- Versión ${v.date} (${v.source_id}) ---\n${v.text.slice(0, 500)}\n\n`;
				}
			} else {
				// If many versions, include first, second-to-last, and last
				changeSummary += `--- Versión original ${firstVersion.date} ---\n${firstVersion.text.slice(0, 500)}\n\n`;
				const prevVersion = versions[versions.length - 2];
				changeSummary += `--- Versión anterior ${prevVersion.date} ---\n${prevVersion.text.slice(0, 500)}\n\n`;
				changeSummary += `--- Versión vigente ${lastVersion.date} ---\n${lastVersion.text.slice(0, 500)}\n\n`;
			}
		}

		return {
			normId: article.normId,
			blockId: article.blockId,
			blockTitle: article.blockTitle,
			currentText: article.text,
			versions,
			hasChanges,
			changeSummary,
		};
	});
}

/**
 * Build evidence text with temporal context.
 * If an article has changes, includes the version history.
 */
export function buildTemporalEvidence(
	contexts: TemporalContext[],
	maxTokens: number = 6000,
): string {
	let evidence = "";
	let approxTokens = 0;

	for (const ctx of contexts) {
		let chunk: string;
		if (ctx.hasChanges) {
			chunk =
				`[${ctx.normId}, ${ctx.blockTitle}]\n` +
				`${ctx.changeSummary}\n` +
				`TEXTO VIGENTE:\n${ctx.currentText}\n\n`;
		} else {
			chunk = `[${ctx.normId}, ${ctx.blockTitle}]\n${ctx.currentText}\n\n`;
		}

		const chunkTokens = Math.ceil(chunk.length / 4);
		if (approxTokens + chunkTokens > maxTokens) break;
		evidence += chunk;
		approxTokens += chunkTokens;
	}

	return evidence;
}
