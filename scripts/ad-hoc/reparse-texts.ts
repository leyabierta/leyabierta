/**
 * Re-fetch laws from the BOE with the current parser and commit the ones whose
 * rendered text changes (PR #217 follow-up).
 *
 * Why it is needed: until PR #217 the XML parser dropped every
 * `<blockquote class="sangrado">` — the text an amending law inserts into
 * another one ("queda redactado como sigue: «…»"). Hundreds of laws in `leyes`,
 * the JSON cache and the DB stop at that colon (BOE-A-2026-20385, art. único:
 * 475 characters out of 8,750). The pipeline never re-renders them by itself:
 * the commit phase skips every reform whose Source-Id already has a commit.
 *
 * For each ID (from --ids FILE, or every file in the repo with --all):
 *   1. `fetchNorm` from the BOE — exactly what `pipeline bootstrap` renders.
 *      With --apply it writes into the real JSON cache (--json), so `ingest`
 *      picks the new text up; a dry run fetches into a throwaway dir.
 *   2. Only if the BOE has EXACTLY the reforms the file lists (see
 *      restore-regressed-texts.ts: a newer reform must get its own commit)
 *      and places the law at the path it already has, re-render it at the
 *      file's own `ultima_actualizacion`, with its materias/notas/referencias.
 *   3. If the body differs, write it through `GitRepo.writeAndAdd` and commit
 *      `<título corto> — texto completo` (type fix-pipeline, author date today,
 *      no Source-Id; Source-Date = the date it is rendered at, as in
 *      restore-regressed-texts.ts).
 * It never moves or creates files and never pushes. `--changed FILE` writes
 * the IDs whose text changed, for the DB steps (ingest, embeddings, summaries)
 * listed in the PR that added this script.
 *
 * Usage (inside the api container, holding the pipeline lock for --apply):
 *   bun run scripts/ad-hoc/reparse-texts.ts --repo /data/leyes \
 *     (--ids FILE | --all) [--json /data/json] [--apply] [--changed FILE] \
 *     [--concurrency N]
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCountry } from "../../packages/pipeline/src/country.ts";
import { GitRepo } from "../../packages/pipeline/src/git/repo.ts";
import type { CommitInfo, Norm } from "../../packages/pipeline/src/models.ts";
import {
	assertUniqueByNormId,
	fetchNorm,
} from "../../packages/pipeline/src/pipeline.ts";
import { SPAIN_JURISDICTION_CODES } from "../../packages/pipeline/src/spain/jurisdictions.ts";
import { renderNormAtDate } from "../../packages/pipeline/src/transform/markdown.ts";
import { normToFilepath } from "../../packages/pipeline/src/transform/slug.ts";
import {
	compareReforms,
	parseAllowList,
	parseFileFrontmatter,
	type SourceState,
} from "./restore-regressed-texts.ts";
import "../../packages/pipeline/src/spain/index.ts";

export interface ReparsePlan {
	readonly id: string;
	readonly relPath: string;
	readonly state: SourceState | "no-file";
	readonly skipReason?: string;
	/** Date the file is (and stays) rendered at. */
	readonly renderedAt?: string;
	/** New content, only when the body changes. */
	readonly content?: string;
	readonly charsBefore?: number;
	readonly charsAfter?: number;
}

const bodyOf = (md: string) => {
	const end = md.startsWith("---\n") ? md.indexOf("\n---", 4) : -1;
	return end === -1 ? md : md.slice(end + 4);
};

/** Decide what to do with one law (pure). */
export function planReparse(
	relPath: string,
	markdown: string | undefined,
	source: Norm | undefined,
): ReparsePlan {
	const id = relPath.split("/")[1]?.replace(/\.md$/, "") ?? relPath;
	if (markdown === undefined) return { id, relPath, state: "no-file" };
	const fm = parseFileFrontmatter(markdown);
	if (!fm?.lastUpdated || !/^\d{4}-\d{2}-\d{2}$/.test(fm.lastUpdated)) {
		return {
			id,
			relPath,
			state: "missing",
			skipReason: "frontmatter sin ultima_actualizacion",
		};
	}
	const state = compareReforms(fm, source);
	if (state !== "match" || !source) return { id, relPath, state };
	const rel = normToFilepath(source.metadata);
	if (rel !== relPath) {
		return {
			id,
			relPath,
			state,
			skipReason: `la fuente lo sitúa en ${rel}`,
		};
	}
	const content = renderNormAtDate(
		source.metadata,
		source.blocks,
		fm.lastUpdated,
		source.reforms,
		fm.analisis,
	);
	const before = bodyOf(markdown);
	const after = bodyOf(content);
	return {
		id,
		relPath,
		state,
		renderedAt: fm.lastUpdated,
		charsBefore: before.length,
		charsAfter: after.length,
		...(after !== before ? { content } : {}),
	};
}

export function buildReparseCommit(
	norm: Pick<Norm, "metadata">,
	plan: ReparsePlan & { renderedAt: string },
	today: string,
): CommitInfo {
	const { metadata } = norm;
	return {
		commitType: "fix-pipeline",
		subject: `${metadata.shortTitle} — texto completo`,
		body: [
			"Se incluye el texto que esta ley introduce o modifica en otras",
			"(«queda redactado como sigue: …»), que el pipeline omitía.",
			"Corrección del pipeline, sin nueva disposición del BOE.",
			"",
			`Norma: ${metadata.id}`,
			`Fecha: ${plan.renderedAt}`,
			`Fuente: ${metadata.source}`,
		].join("\n"),
		trailers: { "Source-Date": plan.renderedAt, "Norm-Id": metadata.id },
		authorName: "Ley Abierta",
		authorEmail: "bot@leyabierta.es",
		authorDate: today,
		filePath: plan.relPath,
		content: plan.content ?? "",
	};
}

// ─── CLI ───

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** id -> repo-relative path, for every law file in the repo. */
function indexRepo(repoPath: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const j of SPAIN_JURISDICTION_CODES) {
		const dir = join(repoPath, j);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".md")) out.set(f.slice(0, -3), `${j}/${f}`);
		}
	}
	return out;
}

async function main() {
	const repoPath = arg("--repo") ?? process.env.REPO_PATH;
	const idsPath = arg("--ids");
	const all = process.argv.includes("--all");
	if (!repoPath || (!idsPath && !all)) {
		console.error("Uso: --repo PATH (--ids FILE | --all) [--apply]");
		process.exit(2);
	}
	const apply = process.argv.includes("--apply");
	const jsonDir = arg("--json") ?? "./data/json";
	const concurrency = Number(arg("--concurrency") ?? "2");
	const changedPath = arg("--changed");

	if (apply) {
		const staged = execFileSync(
			"git",
			["-C", repoPath, "diff", "--cached", "--name-only"],
			{ encoding: "utf-8" },
		).trim();
		if (staged) {
			console.error(`Hay cambios preparados en ${repoPath}; abortando.`);
			process.exit(1);
		}
	}

	const paths = indexRepo(repoPath);
	const ids = all
		? [...paths.keys()].sort()
		: [...parseAllowList(readFileSync(idsPath!, "utf-8"))];
	// fetchNorm writes <dataDir>/json/<id>.json.
	const scratch = apply ? undefined : mkdtempSync(join(tmpdir(), "reparse-"));
	const dataDir = scratch ?? join(jsonDir, "..");

	const country = getCountry("es");
	const plans: ReparsePlan[] = [];
	const sources = new Map<string, Norm>();
	let next = 0;
	const worker = async () => {
		const client = country.client();
		try {
			while (next < ids.length) {
				const id = ids[next++]!;
				const relPath = paths.get(id) ?? `?/${id}.md`;
				const md = paths.has(id)
					? readFileSync(join(repoPath, relPath), "utf-8")
					: undefined;
				let norm: Norm | undefined;
				if (md !== undefined) {
					try {
						norm =
							(await fetchNorm(
								id,
								client,
								country.textParser(),
								country.metadataParser(),
								dataDir,
							)) ?? undefined;
					} catch (err) {
						console.warn(
							`  ✗ ${id}: ${err instanceof Error ? err.message : err}`,
						);
					}
				}
				const plan = planReparse(relPath, md, norm);
				plans.push(plan);
				if (norm && plan.content) sources.set(id, norm);
				if (plans.length % 200 === 0) {
					console.log(
						`  [${plans.length}/${ids.length}] con texto nuevo: ${sources.size}`,
					);
				}
			}
		} finally {
			await client.close();
		}
	};
	try {
		await Promise.all(Array.from({ length: concurrency }, worker));
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}

	plans.sort((a, b) => a.id.localeCompare(b.id));
	const changed = plans.filter((p) => p.content);
	const skipped = plans.filter((p) => p.state !== "match" || p.skipReason);
	console.log(
		`Revisadas: ${plans.length}. Con texto nuevo: ${changed.length}. No comparables: ${skipped.length}.`,
	);
	for (const p of changed) {
		console.log(
			`  ${p.id.padEnd(22)} ${String(p.charsBefore).padStart(8)} -> ${String(p.charsAfter).padStart(8)}`,
		);
	}
	for (const p of skipped) {
		console.log(`  ${p.id.padEnd(22)} <${p.skipReason ?? p.state}>`);
	}
	if (changedPath) {
		writeFileSync(changedPath, `${changed.map((p) => p.id).join("\n")}\n`);
	}
	if (!apply) {
		console.log("\nDry run: no se ha escrito nada. Usa --apply.");
		return;
	}

	const repo = new GitRepo(repoPath, "Ley Abierta", "bot@leyabierta.es");
	const today = new Date().toISOString().slice(0, 10);
	let commits = 0;
	for (const p of changed) {
		const norm = sources.get(p.id);
		if (!norm || !p.renderedAt || !repo.writeAndAdd(p.relPath, p.content!))
			continue;
		await repo.add(p.relPath);
		const sha = await repo.commit(
			buildReparseCommit(
				norm,
				p as ReparsePlan & { renderedAt: string },
				today,
			),
		);
		if (sha) commits++;
	}
	await assertUniqueByNormId(repoPath);
	console.log(`Commits: ${commits}. assertUniqueByNormId: OK. Sin push.`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
