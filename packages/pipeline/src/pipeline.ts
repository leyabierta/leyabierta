/**
 * Pipeline orchestrator.
 *
 * Coordinates the flow: fetch -> parse -> transform -> commit.
 * Country-agnostic — delegates to country-specific implementations
 * via the registry.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
	LegislativeClient,
	MetadataParser,
	TextParser,
} from "./country.ts";
import { buildCommitInfo } from "./git/message.ts";
import { GitRepo } from "./git/repo.ts";
import type { Norm, NormMetadata, Reform } from "./models.ts";
import { SPAIN_JURISDICTION_CODES } from "./spain/jurisdictions.ts";
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
	repoPath: "../leyes",
	dataDir: "./data",
	committerName: "Ley Abierta",
	committerEmail: "bot@leyabierta.es",
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

		if (await repo.hasCommitWithSourceId(reform.normId, metadata.id)) {
			continue;
		}

		const isFirst = i === 0;
		const commitType = isFirst ? "bootstrap" : "reforma";

		const markdown = renderNormAtDate(
			metadata,
			blocks,
			reform.date,
			norm.reforms,
			norm.analisis,
		);
		const changed = repo.writeAndAdd(filePath, markdown);

		if (!changed && !isFirst) continue;

		// Always stage — even if unchanged for bootstrap (file may have been
		// written by another norm's commit, we still need our own commit)
		await repo.add(filePath);

		const info = buildCommitInfo(
			commitType,
			metadata,
			reform,
			blocks,
			filePath,
			markdown,
		);
		const sha = await repo.commit(info, isFirst);

		if (sha) {
			commitsCreated++;
			console.log(`  ✓ ${reform.date} — ${info.subject}`);
		}
	}

	return commitsCreated;
}

/** A single reform entry with its parent norm context, for chronological sorting. */
export interface ReformEntry {
	readonly norm: Norm;
	readonly reformIndex: number;
	readonly reform: Reform;
}

/**
 * Collect all reform entries from multiple norms, sorted chronologically.
 * Within the same date, bootstrap commits (reformIndex === 0) come first,
 * then ordered by norm publication date as tiebreaker.
 */
export function collectReformEntries(norms: Norm[]): ReformEntry[] {
	const entries: ReformEntry[] = [];

	for (const norm of norms) {
		for (let i = 0; i < norm.reforms.length; i++) {
			entries.push({
				norm,
				reformIndex: i,
				reform: norm.reforms[i]!,
			});
		}
	}

	entries.sort((a, b) => {
		const dateCmp = a.reform.date.localeCompare(b.reform.date);
		if (dateCmp !== 0) return dateCmp;
		// Same date: bootstraps first
		if (a.reformIndex === 0 && b.reformIndex !== 0) return -1;
		if (a.reformIndex !== 0 && b.reformIndex === 0) return 1;
		// Same date, same type: order by norm publication date
		return a.norm.metadata.publishedAt.localeCompare(
			b.norm.metadata.publishedAt,
		);
	});

	return entries;
}

/**
 * Commit multiple norms in global chronological order.
 * All reforms across all norms are sorted by date before committing.
 */
export async function commitNormsChronologically(
	norms: Norm[],
	config: Partial<PipelineConfig> = {},
	onProgress?: (done: number, total: number, subject: string) => void,
): Promise<number> {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	const repo = new GitRepo(cfg.repoPath, cfg.committerName, cfg.committerEmail);
	await repo.init();
	await repo.loadExistingCommits();

	const entries = collectReformEntries(norms);
	let commitsCreated = 0;

	for (let i = 0; i < entries.length; i++) {
		const { norm, reformIndex, reform } = entries[i]!;
		const { metadata, blocks } = norm;

		if (await repo.hasCommitWithSourceId(reform.normId, metadata.id)) {
			continue;
		}

		const isFirst = reformIndex === 0;
		const commitType = isFirst ? "bootstrap" : "reforma";

		const filePath = normToFilepath(metadata);
		const markdown = renderNormAtDate(
			metadata,
			blocks,
			reform.date,
			norm.reforms,
			norm.analisis,
		);
		const changed = repo.writeAndAdd(filePath, markdown);

		if (!changed && !isFirst) continue;

		await repo.add(filePath);

		const info = buildCommitInfo(
			commitType,
			metadata,
			reform,
			blocks,
			filePath,
			markdown,
		);
		const sha = await repo.commit(info, isFirst);

		if (sha) {
			commitsCreated++;
			if (onProgress) {
				onProgress(commitsCreated, entries.length, info.subject);
			} else {
				console.log(`  ✓ ${reform.date} — ${info.subject}`);
			}
		}
	}

	// Note: the post-bootstrap `assertUniqueByNormId` invariant check is the
	// caller's responsibility — it must be called AFTER persisting state, not
	// here. Otherwise a thrown assertion would leave commits made but state
	// unpersisted, causing the next run to re-fetch everything.
	return commitsCreated;
}

/**
 * Scan all `<jurisdiction>/<id>.md` files in repoPath and assert that each
 * norm ID appears in exactly one jurisdiction folder.
 *
 * Called at the end of commitNormsChronologically as a post-bootstrap sanity
 * check. If the repo is already inconsistent (e.g., due to a manual backfill
 * script), this surfaces all conflicts at once instead of silently proceeding.
 *
 * Throws with a full list of conflicts if any norm ID appears in more than one
 * jurisdiction folder. Does nothing when the repo is clean.
 */
export async function assertUniqueByNormId(repoPath: string): Promise<void> {
	if (!existsSync(repoPath)) return;

	/** norm ID → list of jurisdictions where it was found */
	const seen = new Map<string, string[]>();

	// Iterate the canonical list of jurisdictions instead of scanning the
	// repo top-level dirs. The list is the single source of truth (see
	// `spain/jurisdictions.ts`); the writer enforces against the same list,
	// so writer and asserter agree by construction.
	for (const jurisdiction of SPAIN_JURISDICTION_CODES) {
		const dirPath = join(repoPath, jurisdiction);
		if (!existsSync(dirPath)) continue;
		let files: string[];
		try {
			files = readdirSync(dirPath);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			const normId = file.slice(0, -3);
			const existing = seen.get(normId);
			if (existing) {
				existing.push(jurisdiction);
			} else {
				seen.set(normId, [jurisdiction]);
			}
		}
	}

	const conflicts: string[] = [];
	for (const [normId, jurisdictions] of seen) {
		if (jurisdictions.length > 1) {
			conflicts.push(`  ${normId}: found in [${jurisdictions.join(", ")}]`);
		}
	}

	if (conflicts.length > 0) {
		throw new Error(
			`assertUniqueByNormId: ${conflicts.length} norm(s) exist in multiple jurisdiction folders.\n` +
				conflicts.join("\n"),
		);
	}
}

/**
 * Fetch and parse a single norm from the remote API.
 * Returns the Norm object without committing. Returns null if no text available.
 */
export async function fetchNorm(
	normId: string,
	client: LegislativeClient,
	textParser: TextParser,
	metadataParser: MetadataParser,
	dataDir: string = "./data",
): Promise<Norm | null> {
	const [textData, metaData] = await Promise.all([
		client.getText(normId),
		client.getMetadata(normId),
	]);

	const metadata = metadataParser.parse(metaData, normId);
	const blocks = textParser.parseText(textData);
	let reforms = textParser.extractReforms(blocks);

	if (blocks.length === 0) {
		return null;
	}

	// Norms with blocks but no version history (e.g. missing fecha_publicacion
	// in XML) get a synthetic bootstrap reform from the metadata publication
	// date. If the metadata itself fell back to the BOE sentinel (1900-01-01),
	// flag it loudly — we have no real date for this norm and the commit will
	// end up clamped to 1970-01-02, which is wrong but at least auditable
	// from the warning.
	if (reforms.length === 0) {
		if (!metadata.publishedAt || metadata.publishedAt === "1900-01-01") {
			console.warn(
				`[pipeline] ${metadata.id} has no version history AND no real ` +
					`publishedAt — falling back to "${metadata.publishedAt}". ` +
					`Commit date will be clamped/wrong; investigate BOE metadata.`,
			);
		}
		reforms = [
			{
				date: metadata.publishedAt,
				normId: metadata.id,
				affectedBlockIds: blocks.map((b) => b.id),
			},
		];
	}

	const norm: Norm = { metadata, blocks, reforms };

	// Save JSON cache
	const jsonDir = `${dataDir}/json`;
	await Bun.write(
		`${jsonDir}/${metadata.id}.json`,
		JSON.stringify(normToJson(norm), null, 2),
	);

	return norm;
}

/**
 * Bootstrap a single norm from the remote API (fetch + commit).
 * Kept for backwards compatibility and simple single-norm usage.
 */
export async function bootstrapFromApi(
	normId: string,
	client: LegislativeClient,
	textParser: TextParser,
	metadataParser: MetadataParser,
	config: Partial<PipelineConfig> = {},
): Promise<number> {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	const norm = await fetchNorm(
		normId,
		client,
		textParser,
		metadataParser,
		cfg.dataDir,
	);
	if (!norm) return -1;

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
			currentText: (() => {
				if (block.versions.length === 0) return "";
				// Use the most recent version that has text content,
				// falling back to the most recent version overall
				const sorted = block.versions.toSorted((a, b) =>
					b.publishedAt.localeCompare(a.publishedAt),
				);
				const withText = sorted.find((v) =>
					v.paragraphs.some((p) => p.text.trim()),
				);
				const best = withText ?? sorted[0]!;
				return best.paragraphs.map((p) => p.text).join("\n\n");
			})(),
		})),
		reforms: reforms.map((r) => ({
			date: r.date,
			sourceId: r.normId,
			affectedBlocks: r.affectedBlockIds,
		})),
		...(norm.analisis
			? {
					analisis: {
						materias: norm.analisis.materias,
						notas: norm.analisis.notas,
						referencias: norm.analisis.referencias,
					},
				}
			: {}),
	};
}
