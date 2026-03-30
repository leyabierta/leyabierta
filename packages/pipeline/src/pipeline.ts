/**
 * Pipeline orchestrator.
 *
 * Coordinates the flow: fetch -> parse -> transform -> commit.
 * Country-agnostic — delegates to country-specific implementations
 * via the registry.
 */

import type {
	LegislativeClient,
	MetadataParser,
	TextParser,
} from "./country.ts";
import { buildCommitInfo } from "./git/message.ts";
import { GitRepo } from "./git/repo.ts";
import type { Norm, NormMetadata } from "./models.ts";
import { renderNormAtDate } from "./transform/markdown.ts";
import { normToFilepath } from "./transform/slug.ts";
import { extractReforms, parseTextXml } from "./transform/xml-parser.ts";

export interface PipelineConfig {
	repoPath: string;
	dataDir: string;
	committerName: string;
	committerEmail: string;
}

const DEFAULT_CONFIG: PipelineConfig = {
	repoPath: "./output/es",
	dataDir: "./data",
	committerName: "Ley Libre",
	committerEmail: "bot@leylibre.es",
};

/**
 * Bootstrap from a local XML file (for testing and initial development).
 */
export async function bootstrapFromLocalXml(
	metadata: NormMetadata,
	xmlPath: string,
	config: Partial<PipelineConfig> = {},
): Promise<number> {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	const xmlBytes = await Bun.file(xmlPath).bytes();
	const blocks = parseTextXml(xmlBytes);
	const reforms = extractReforms(blocks);

	const norm: Norm = { metadata, blocks, reforms };

	// Save JSON cache
	const jsonDir = `${cfg.dataDir}/json`;
	await Bun.write(
		`${jsonDir}/${metadata.id}.json`,
		JSON.stringify(normToJson(norm), null, 2),
	);

	return commitNorm(norm, cfg);
}

/**
 * Commit all reforms of a norm to the git repo.
 */
export async function commitNorm(
	norm: Norm,
	config: Partial<PipelineConfig> = {},
): Promise<number> {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const { metadata, blocks, reforms } = norm;

	const repo = new GitRepo(cfg.repoPath, cfg.committerName, cfg.committerEmail);
	await repo.init();
	await repo.loadExistingCommits();

	const filePath = normToFilepath(metadata);
	let commitsCreated = 0;

	for (let i = 0; i < reforms.length; i++) {
		const reform = reforms[i]!;

		if (repo.hasCommitWithSourceId(reform.normId, metadata.id)) {
			continue;
		}

		const isFirst = i === 0;
		const commitType = isFirst ? "bootstrap" : "reforma";

		const markdown = renderNormAtDate(metadata, blocks, reform.date);
		const changed = repo.writeAndAdd(filePath, markdown);

		if (!changed && !isFirst) continue;

		if (changed) {
			await repo.add(filePath);
		}

		const info = buildCommitInfo(
			commitType,
			metadata,
			reform,
			blocks,
			filePath,
			markdown,
		);
		const sha = await repo.commit(info);

		if (sha) {
			commitsCreated++;
			console.log(`  ✓ ${reform.date} — ${info.subject}`);
		}
	}

	return commitsCreated;
}

/**
 * Bootstrap a single norm from the remote API.
 */
export async function bootstrapFromApi(
	normId: string,
	client: LegislativeClient,
	textParser: TextParser,
	metadataParser: MetadataParser,
	config: Partial<PipelineConfig> = {},
): Promise<number> {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	const [textData, metaData] = await Promise.all([
		client.getText(normId),
		client.getMetadata(normId),
	]);

	const metadata = metadataParser.parse(metaData, normId);
	const blocks = textParser.parseText(textData);
	const reforms = textParser.extractReforms(blocks);

	if (blocks.length === 0 || reforms.length === 0) {
		return 0;
	}

	const norm: Norm = { metadata, blocks, reforms };

	// Save JSON cache
	const jsonDir = `${cfg.dataDir}/json`;
	await Bun.write(
		`${jsonDir}/${metadata.id}.json`,
		JSON.stringify(normToJson(norm), null, 2),
	);

	return commitNorm(norm, cfg);
}

// ─── Serialization helpers ───

function normToJson(norm: Norm): object {
	const { metadata, blocks, reforms } = norm;

	return {
		metadata: {
			title: metadata.title,
			shortTitle: metadata.shortTitle,
			id: metadata.id,
			country: metadata.country,
			rank: String(metadata.rank),
			published: metadata.publishedAt,
			updated: metadata.updatedAt ?? metadata.publishedAt,
			status: metadata.status,
			department: metadata.department,
			source: metadata.source,
		},
		articles: blocks.map((block, i) => ({
			blockId: block.id,
			blockType: block.type,
			title: block.title,
			position: i,
			versions: block.versions.map((v) => ({
				date: v.publishedAt,
				sourceId: v.normId,
				text: v.paragraphs.map((p) => p.text).join("\n\n"),
			})),
			currentText:
				block.versions.length > 0
					? block.versions
							.toSorted((a, b) =>
								b.publishedAt.localeCompare(a.publishedAt),
							)[0]!
							.paragraphs.map((p) => p.text)
							.join("\n\n")
					: "",
		})),
		reforms: reforms.map((r) => ({
			date: r.date,
			sourceId: r.normId,
			affectedBlocks: r.affectedBlockIds,
		})),
	};
}
