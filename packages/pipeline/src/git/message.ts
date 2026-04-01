/**
 * Structured commit message construction.
 *
 * Format:
 *   [type] Title — affected articles
 *
 *   Norma: BOE-A-1978-31229
 *   Fecha: 2024-02-17
 *   Fuente: https://www.boe.es/...
 *
 *   Source-Id: BOE-A-2024-3099
 *   Source-Date: 2024-02-17
 *   Norm-Id: BOE-A-1978-31229
 */

import type {
	Block,
	CommitInfo,
	CommitType,
	NormMetadata,
	Reform,
} from "../models.ts";

const AUTHOR_NAME = "Ley Abierta";
const AUTHOR_EMAIL = "bot@leyabierta.es";

export function buildCommitInfo(
	commitType: CommitType,
	metadata: NormMetadata,
	reform: Reform,
	blocks: readonly Block[],
	filePath: string,
	content: string,
): CommitInfo {
	const articles = getAffectedArticles(reform, blocks);
	const artsStr = articles.length > 0 ? articles.join(", ") : "N/A";

	const subject = buildSubject(commitType, metadata, reform, articles);
	const body = buildBody(commitType, metadata, reform, artsStr);

	return {
		commitType,
		subject,
		body,
		trailers: {
			"Source-Id": reform.normId,
			"Source-Date": reform.date,
			"Norm-Id": metadata.id,
		},
		authorName: AUTHOR_NAME,
		authorEmail: AUTHOR_EMAIL,
		authorDate: reform.date,
		filePath,
		content,
	};
}

export function formatCommitMessage(info: CommitInfo): string {
	const parts = [info.subject, "", info.body];

	if (Object.keys(info.trailers).length > 0) {
		parts.push("");
		for (const [key, value] of Object.entries(info.trailers)) {
			parts.push(`${key}: ${value}`);
		}
	}

	return parts.join("\n");
}

function buildSubject(
	commitType: CommitType,
	metadata: NormMetadata,
	reform: Reform,
	articles: string[],
): string {
	const title = metadata.shortTitle;

	if (commitType === "bootstrap") {
		const year = reform.date.slice(0, 4);
		return `${title} — publicación original (${year})`;
	}

	if (commitType === "fix-pipeline") {
		return `${title} — regeneración`;
	}

	if (commitType === "derogacion") {
		return `${title} — derogación`;
	}

	if (commitType === "correccion") {
		const brief = abbreviateArticles(articles);
		if (brief) return `${title} — corrección ${brief}`;
		return `${title} — corrección de errores`;
	}

	// reforma / nueva
	if (articles.length > 0) {
		const brief = abbreviateArticles(articles);
		if (brief) return `${title} — reforma ${brief}`;
	}

	return `${title} — reforma`;
}

function buildBody(
	commitType: CommitType,
	metadata: NormMetadata,
	reform: Reform,
	articlesStr: string,
): string {
	if (commitType === "bootstrap") {
		return [
			`Publicación original de ${metadata.shortTitle}.`,
			"",
			`Norma: ${metadata.id}`,
			`Fecha: ${reform.date}`,
			`Fuente: ${metadata.source}`,
		].join("\n");
	}

	return [
		`Norma: ${metadata.id}`,
		`Disposición: ${reform.normId}`,
		`Fecha: ${reform.date}`,
		`Fuente: ${metadata.source}`,
		"",
		`Artículos afectados: ${articlesStr}`,
	].join("\n");
}

function abbreviateArticles(articles: string[]): string {
	const nums: string[] = [];
	for (const art of articles) {
		const match = art.match(/(\d+)/);
		if (match) nums.push(match[1]!);
	}

	if (nums.length === 0) return "";
	if (nums.length === 1) return `art. ${nums[0]}`;
	if (nums.length <= 4) return `arts. ${nums.join(", ")}`;

	return `arts. ${nums.slice(0, 3).join(", ")} y ${nums.length - 3} más`;
}

function getAffectedArticles(
	reform: Reform,
	blocks: readonly Block[],
): string[] {
	const blockMap = new Map(blocks.map((b) => [b.id, b]));
	const titles: string[] = [];

	for (const blockId of reform.affectedBlockIds) {
		const block = blockMap.get(blockId);
		if (block?.title) titles.push(block.title);
	}

	return titles;
}
