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

const AUTHOR_NAME = "Ley Libre";
const AUTHOR_EMAIL = "bot@leylibre.es";

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
	const prefix = `[${commitType}]`;
	const title = metadata.shortTitle;

	if (commitType === "bootstrap") {
		const year = reform.date.slice(0, 4);
		return `${prefix} ${title} — original version ${year}`;
	}

	if (commitType === "fix-pipeline") {
		return `${prefix} Regenerate ${title}`;
	}

	if (articles.length > 0) {
		const brief = abbreviateArticles(articles);
		if (brief) return `${prefix} ${title} — ${brief}`;
	}

	return `${prefix} ${title}`;
}

function buildBody(
	commitType: CommitType,
	metadata: NormMetadata,
	reform: Reform,
	articlesStr: string,
): string {
	if (commitType === "bootstrap") {
		return [
			`Original publication of ${metadata.shortTitle}.`,
			"",
			`Norm: ${metadata.id}`,
			`Date: ${reform.date}`,
			`Source: ${metadata.source}`,
		].join("\n");
	}

	return [
		`Norm: ${metadata.id}`,
		`Disposition: ${reform.normId}`,
		`Date: ${reform.date}`,
		`Source: ${metadata.source}`,
		"",
		`Affected articles: ${articlesStr}`,
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

	return `arts. ${nums.slice(0, 3).join(", ")} and ${nums.length - 3} more`;
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
