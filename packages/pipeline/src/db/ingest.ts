/**
 * Ingest JSON cache files into SQLite.
 *
 * Reads the data/json/*.json files produced by the pipeline
 * and inserts them into the database in a single transaction.
 */

import type { Database } from "bun:sqlite";
import { Glob } from "bun";

/** Shape of the JSON cache files written by pipeline.ts */
interface CachedNorm {
	metadata: {
		title: string;
		shortTitle: string;
		id: string;
		country: string;
		rank: string;
		published: string;
		updated: string;
		status: string;
		department: string;
		source: string;
	};
	articles: Array<{
		blockId: string;
		blockType: string;
		title: string;
		position: number;
		versions: Array<{
			date: string;
			sourceId: string;
			text: string;
		}>;
		currentText: string;
	}>;
	reforms: Array<{
		date: string;
		sourceId: string;
		affectedBlocks: string[];
	}>;
}

export interface IngestResult {
	normsInserted: number;
	blocksInserted: number;
	versionsInserted: number;
	reformsInserted: number;
	errors: string[];
}

export async function ingestJsonDir(
	db: Database,
	jsonDir: string,
): Promise<IngestResult> {
	const result: IngestResult = {
		normsInserted: 0,
		blocksInserted: 0,
		versionsInserted: 0,
		reformsInserted: 0,
		errors: [],
	};

	const glob = new Glob("*.json");
	const files: string[] = [];
	for await (const path of glob.scan(jsonDir)) {
		files.push(`${jsonDir}/${path}`);
	}

	if (files.length === 0) {
		result.errors.push(`No JSON files found in ${jsonDir}`);
		return result;
	}

	const insertNorm = db.prepare(/* sql */ `
		INSERT OR REPLACE INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url)
		VALUES ($id, $title, $shortTitle, $country, $rank, $publishedAt, $updatedAt, $status, $department, $sourceUrl)
	`);

	const insertBlock = db.prepare(/* sql */ `
		INSERT OR REPLACE INTO blocks (norm_id, block_id, block_type, title, position, current_text)
		VALUES ($normId, $blockId, $blockType, $title, $position, $currentText)
	`);

	const insertVersion = db.prepare(/* sql */ `
		INSERT OR REPLACE INTO versions (norm_id, block_id, date, source_id, text)
		VALUES ($normId, $blockId, $date, $sourceId, $text)
	`);

	const insertReform = db.prepare(/* sql */ `
		INSERT OR REPLACE INTO reforms (norm_id, date, source_id)
		VALUES ($normId, $date, $sourceId)
	`);

	const insertReformBlock = db.prepare(/* sql */ `
		INSERT OR REPLACE INTO reform_blocks (norm_id, reform_date, reform_source_id, block_id)
		VALUES ($normId, $reformDate, $reformSourceId, $blockId)
	`);

	const deleteFts = db.prepare(/* sql */ `
		DELETE FROM norms_fts WHERE norm_id = $normId
	`);

	const insertFts = db.prepare(/* sql */ `
		INSERT INTO norms_fts (norm_id, title, content)
		VALUES ($normId, $title, $content)
	`);

	// Load all files first (async), then insert in a single transaction
	const norms: Array<{ file: string; data: CachedNorm }> = [];
	for (const file of files) {
		try {
			const data = (await Bun.file(file).json()) as CachedNorm;
			norms.push({ file, data });
		} catch (e) {
			result.errors.push(`Failed to read ${file}: ${e}`);
		}
	}

	const insertAll = db.transaction(() => {
		for (const { file, data } of norms) {
			try {
				const { metadata, articles, reforms } = data;

				insertNorm.run({
					$id: metadata.id,
					$title: metadata.title,
					$shortTitle: metadata.shortTitle,
					$country: metadata.country,
					$rank: metadata.rank,
					$publishedAt: metadata.published,
					$updatedAt: metadata.updated,
					$status: metadata.status,
					$department: metadata.department,
					$sourceUrl: metadata.source,
				});
				result.normsInserted++;

				// Collect all article texts for FTS
				const allTexts: string[] = [];

				for (const article of articles) {
					insertBlock.run({
						$normId: metadata.id,
						$blockId: article.blockId,
						$blockType: article.blockType,
						$title: article.title,
						$position: article.position,
						$currentText: article.currentText,
					});
					result.blocksInserted++;

					if (article.currentText) {
						allTexts.push(article.currentText);
					}

					for (const version of article.versions) {
						insertVersion.run({
							$normId: metadata.id,
							$blockId: article.blockId,
							$date: version.date,
							$sourceId: version.sourceId,
							$text: version.text,
						});
						result.versionsInserted++;
					}
				}

				for (const reform of reforms) {
					insertReform.run({
						$normId: metadata.id,
						$date: reform.date,
						$sourceId: reform.sourceId,
					});
					result.reformsInserted++;

					for (const blockId of reform.affectedBlocks) {
						insertReformBlock.run({
							$normId: metadata.id,
							$reformDate: reform.date,
							$reformSourceId: reform.sourceId,
							$blockId: blockId,
						});
					}
				}

				// FTS entry: delete old row first (FTS5 does not deduplicate on INSERT OR REPLACE)
				deleteFts.run({ $normId: metadata.id });
				insertFts.run({
					$normId: metadata.id,
					$title: metadata.title,
					$content: allTexts.join("\n"),
				});
			} catch (e) {
				result.errors.push(`Failed to ingest ${file}: ${e}`);
			}
		}
	});

	insertAll();

	return result;
}
