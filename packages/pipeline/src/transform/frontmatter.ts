/**
 * YAML frontmatter generation for norm Markdown files.
 */

import type { NormMetadata } from "../models.ts";

export function renderFrontmatter(
	metadata: NormMetadata,
	versionDate: string,
): string {
	const title = cleanTitle(metadata.title);

	const lines = [
		"---",
		`title: "${escapeYaml(title)}"`,
		`id: "${metadata.id}"`,
		`country: "${metadata.country}"`,
		`rank: "${metadata.rank}"`,
		`published: "${metadata.publishedAt}"`,
		`updated: "${versionDate}"`,
		`status: "${metadata.status}"`,
		`source: "${metadata.source}"`,
	];

	if (metadata.pdfUrl) {
		lines.push(`pdf: "${metadata.pdfUrl}"`);
	}

	lines.push("---", "");

	return lines.join("\n");
}

function escapeYaml(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function cleanTitle(title: string): string {
	return title.replace(/[\s.]+$/, "").trim();
}
