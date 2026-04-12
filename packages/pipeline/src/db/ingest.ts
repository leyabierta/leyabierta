/**
 * Ingest JSON cache files into SQLite.
 *
 * Reads the data/json/*.json files produced by the pipeline
 * and inserts them into the database in batches to avoid OOM.
 */

import type { Database } from "bun:sqlite";
import { Glob } from "bun";

const DEFAULT_BATCH_SIZE = 100;

/** Map regional bulletin ID prefixes to jurisdiction codes. */
const BULLETIN_JURISDICTION: Record<string, string> = {
	BOA: "es-ar",
	BOJA: "es-an",
	BOCL: "es-cl",
	BOCM: "es-md",
	BOC: "es-cn",
	BOCT: "es-cb",
	BOIB: "es-ib",
	BON: "es-nc",
	BOPV: "es-pv",
	BORM: "es-mc",
	DOCM: "es-cm",
	DOE: "es-ex",
	DOG: "es-ga",
	DOGC: "es-ct",
	DOGV: "es-vc",
};

/** Resolve jurisdiction from ELI source URL or norm ID prefix. */
function resolveJurisdiction(source: string, normId: string): string {
	if (source) {
		const match = source.match(/\/eli\/(es(?:-[a-z]{2})?)\//);
		if (match) return match[1]!;
	}
	const prefix = normId.split("-")[0];
	if (prefix && BULLETIN_JURISDICTION[prefix]) {
		return BULLETIN_JURISDICTION[prefix];
	}
	return "es";
}

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
	duration: number;
}

interface IngestOptions {
	ids?: string[];
	batchSize?: number;
}

/** Validate that a parsed JSON has the required CachedNorm shape. */
export function validateNorm(data: unknown): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];
	if (!data || typeof data !== "object") {
		errors.push("Not an object");
		return { valid: false, errors };
	}

	const d = data as Record<string, unknown>;
	const meta = d.metadata as Record<string, unknown> | undefined;
	if (!meta || typeof meta !== "object") {
		errors.push("Missing metadata");
		return { valid: false, errors };
	}

	for (const field of [
		"id",
		"title",
		"country",
		"rank",
		"published",
		"status",
	]) {
		if (!meta[field] || typeof meta[field] !== "string") {
			errors.push(`Missing or invalid metadata.${field}`);
		}
	}

	if (!Array.isArray(d.articles)) {
		errors.push("Missing articles array");
	}

	if (!Array.isArray(d.reforms)) {
		errors.push("Missing reforms array");
	}

	return { valid: errors.length === 0, errors };
}

/** Normalize a single article from snake_case to camelCase and add defaults. */
export function normalizeArticle(
	article: Record<string, unknown>,
	index: number,
): CachedNorm["articles"][number] {
	const blockId = (article.blockId ?? article.block_id ?? "") as string;
	const blockType = (article.blockType ?? article.block_type ?? "") as string;
	const title = (article.title ?? "") as string;
	const position = (article.position ?? index) as number;
	const versions = (article.versions ??
		[]) as CachedNorm["articles"][number]["versions"];

	let currentText = article.currentText as string | undefined;
	if (currentText === undefined || currentText === null) {
		// Default to the text of the last version
		currentText =
			versions.length > 0 ? versions[versions.length - 1]!.text : "";
	}

	return { blockId, blockType, title, position, versions, currentText };
}

export async function ingestJsonDir(
	db: Database,
	jsonDir: string,
	options?: IngestOptions,
): Promise<IngestResult> {
	const startTime = performance.now();
	const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;

	// Disable fsync for bulk ingest — safe because we can re-run if interrupted
	db.exec("PRAGMA synchronous = OFF");
	db.exec("PRAGMA temp_store = MEMORY");

	const result: IngestResult = {
		normsInserted: 0,
		blocksInserted: 0,
		versionsInserted: 0,
		reformsInserted: 0,
		errors: [],
		duration: 0,
	};

	// Collect file paths
	const glob = new Glob("*.json");
	let files: string[] = [];
	for await (const path of glob.scan(jsonDir)) {
		files.push(`${jsonDir}/${path}`);
	}

	if (files.length === 0) {
		result.errors.push(`No JSON files found in ${jsonDir}`);
		result.duration = performance.now() - startTime;
		return result;
	}

	// Filter by IDs if provided
	if (options?.ids && options.ids.length > 0) {
		const idSet = new Set(options.ids.map((id) => `${id}.json`));
		files = files.filter((f) => {
			const basename = f.split("/").pop() ?? "";
			return idSet.has(basename);
		});
		if (files.length === 0) {
			result.errors.push(
				`No JSON files found for IDs: ${options.ids.join(", ")}`,
			);
			result.duration = performance.now() - startTime;
			return result;
		}
	}

	const totalFiles = files.length;

	// Prepare statements
	const insertNorm = db.prepare(/* sql */ `
		INSERT OR REPLACE INTO norms (id, title, short_title, country, rank, published_at, updated_at, status, department, source_url, citizen_summary)
		VALUES ($id, $title, $shortTitle, $country, $rank, $publishedAt, $updatedAt, $status, $department, $sourceUrl, $citizenSummary)
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

	// Process in batches — data insertion only, FTS rebuilt at end
	const totalBatches = Math.ceil(totalFiles / batchSize);
	const ingestedIds: string[] = [];

	for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
		const batchStart = performance.now();
		const start = batchIndex * batchSize;
		const end = Math.min(start + batchSize, totalFiles);
		const batchFiles = files.slice(start, end);

		// Read and validate this batch
		const batchNorms: Array<{ file: string; data: CachedNorm }> = [];
		for (const file of batchFiles) {
			try {
				const raw = await Bun.file(file).json();

				const validation = validateNorm(raw);
				if (!validation.valid) {
					result.errors.push(
						`Skipping ${file}: ${validation.errors.join(", ")}`,
					);
					continue;
				}

				// Normalize articles
				const data = raw as CachedNorm;
				data.articles = (data.articles || []).map(
					(a: Record<string, unknown>, i: number) => normalizeArticle(a, i),
				);

				batchNorms.push({ file, data });
			} catch (e) {
				result.errors.push(`Failed to read ${file}: ${e}`);
			}
		}

		// Insert batch in a single transaction
		const insertBatch = db.transaction(() => {
			for (const { file, data } of batchNorms) {
				try {
					const { metadata, articles, reforms } = data;

					// Preserve existing citizen_summary if norm is being re-ingested
					const existingSummary =
						db
							.query<{ citizen_summary: string }, [string]>(
								"SELECT citizen_summary FROM norms WHERE id = ?",
							)
							.get(metadata.id)?.citizen_summary ?? "";

					const country = resolveJurisdiction(
						metadata.source ?? "",
						metadata.id,
					);

					insertNorm.run({
						$id: metadata.id,
						$title: metadata.title,
						$shortTitle: metadata.shortTitle ?? "",
						$country: country,
						$rank: metadata.rank,
						$publishedAt: metadata.published,
						$updatedAt: metadata.updated ?? "",
						$status: metadata.status,
						$department: metadata.department ?? "",
						$sourceUrl: metadata.source ?? "",
						$citizenSummary: existingSummary,
					});
					result.normsInserted++;
					ingestedIds.push(metadata.id);

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
				} catch (e) {
					result.errors.push(`Failed to ingest ${file}: ${e}`);
				}
			}
		});

		insertBatch();

		const batchDuration = ((performance.now() - batchStart) / 1000).toFixed(1);
		const processed = end;
		const pct = ((processed / totalFiles) * 100).toFixed(1);
		console.log(
			`  [${processed}/${totalFiles}] batch ${batchIndex + 1}/${totalBatches} (${pct}%) — ${batchDuration}s`,
		);
	}

	// Rebuild FTS index in batches
	const ftsTotal = ingestedIds.length;
	console.log(`  Rebuilding FTS index for ${ftsTotal} norms...`);
	const ftsStart = performance.now();
	const ftsBatchSize = 500;
	const ftsBatches = Math.ceil(ftsTotal / ftsBatchSize);

	const deleteFts = db.prepare(
		/* sql */ `DELETE FROM norms_fts WHERE norm_id = $normId`,
	);
	const insertFts = db.prepare(/* sql */ `
		INSERT INTO norms_fts (norm_id, title, content, citizen_tags, citizen_summary)
		VALUES ($normId, $title, $content, $citizenTags, $citizenSummary)
	`);
	const selectNorm = db.prepare<
		{ title: string; citizen_summary: string },
		[string]
	>("SELECT title, citizen_summary FROM norms WHERE id = ?");
	const selectBlocks = db.prepare<{ current_text: string }, [string]>(
		"SELECT current_text FROM blocks WHERE norm_id = ?",
	);
	const selectTags = db.prepare<{ tag: string }, [string]>(
		"SELECT DISTINCT tag FROM citizen_tags WHERE norm_id = ?",
	);
	const selectSummaries = db.prepare<{ summary: string }, [string]>(
		"SELECT summary FROM citizen_article_summaries WHERE norm_id = ?",
	);

	for (let fi = 0; fi < ftsBatches; fi++) {
		const fbStart = performance.now();
		const fStart = fi * ftsBatchSize;
		const fEnd = Math.min(fStart + ftsBatchSize, ftsTotal);
		const ftsBatch = ingestedIds.slice(fStart, fEnd);

		const rebuildBatch = db.transaction(() => {
			for (const normId of ftsBatch) {
				const norm = selectNorm.get(normId);
				if (!norm) continue;

				const blockTexts = selectBlocks
					.all(normId)
					.map((b) => b.current_text)
					.filter(Boolean)
					.join("\n");

				const citizenTags = selectTags
					.all(normId)
					.map((r) => r.tag)
					.join(" ");

				const articleSummaries = selectSummaries
					.all(normId)
					.map((r) => r.summary)
					.join("\n");

				deleteFts.run({ $normId: normId });
				insertFts.run({
					$normId: normId,
					$title: norm.title,
					$content: `${blockTexts}\n${articleSummaries}`,
					$citizenTags: citizenTags,
					$citizenSummary: norm.citizen_summary,
				});
			}
		});

		rebuildBatch();

		const fbDur = ((performance.now() - fbStart) / 1000).toFixed(1);
		const fPct = ((fEnd / ftsTotal) * 100).toFixed(1);
		console.log(`  FTS [${fEnd}/${ftsTotal}] (${fPct}%) — ${fbDur}s`);
	}

	const ftsDuration = ((performance.now() - ftsStart) / 1000).toFixed(1);
	console.log(`  FTS rebuild done — ${ftsDuration}s`);

	// Restore safe sync mode for normal API operation
	db.exec("PRAGMA synchronous = NORMAL");

	result.duration = performance.now() - startTime;
	return result;
}
