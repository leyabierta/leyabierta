/**
 * Add the missing `materias` / `notas` / `referencias_*` back to the
 * frontmatter of the `leyes` repo files.
 *
 * Why it is needed: `fetchNorm` (the daily `pipeline bootstrap`) never loaded
 * the BOE análisis, so every file it (re)wrote in `leyes` lost `materias`,
 * `notas`, `referencias_anteriores` and `referencias_posteriores`. A full
 * re-bootstrap on top of the existing history (spring 2026) rewrote every law
 * that way, so on 2026-09-23 not one of the 12,412 files in `leyes` had
 * `materias`, while the DB had them for 12,411 norms. Step 3 of the daily
 * pipeline (`ingest-analisis`) refreshes the DB and the JSON cache, but
 * nothing ever rewrote the markdown: `pipeline rebuild` skips every reform
 * that already has a commit. The pipeline fix (same PR) stops new losses; this
 * script repairs the files that already lost it.
 *
 * WHAT IT CHANGES: frontmatter only, additive only. For each file it takes the
 * análisis from the JSON cache (`data/json/<id>.json` → `analisis`, which
 * Step 3 fills from the DB) and adds every análisis key the file lacks. Keys
 * the file already has are never modified or removed. The body is kept byte
 * for byte, and so is every other frontmatter line: a file is only touched
 * when re-dumping its parsed frontmatter reproduces it exactly, so the new
 * frontmatter is the old one plus the new keys, rendered by the same
 * `analisisToFrontmatter` + `yaml.dump` options the pipeline uses.
 *
 * A file is skipped (and reported) when: its frontmatter doesn't round-trip,
 * its `identificador` differs from its file name, it has no JSON cache or the
 * cache has no análisis, or the JSON cache (the jurisdiction authority for
 * ad-hoc scripts, see CLAUDE.md) places the law in another folder. It never
 * moves or creates files, and writes only through `GitRepo.writeAndAdd`.
 *
 * COMMITS: one per `Source-Date` group, not one per law (12k commits would
 * trip the DIVERGENCE_CEILING=200 push guard of daily-pipeline.sh). The API
 * (`GitService.getFileAtDate` / `diff`) picks a file's version by Source-Date,
 * newest-first, so the commit must not claim a date earlier than the content
 * it carries: files whose `ultima_actualizacion` is later than today (the
 * BOE's 2929-11-19) get their own commit with Source-Date = that date; all the
 * others share one commit with Source-Date = today. No `Source-Id`: this is
 * not a BOE disposition, and the pipeline's idempotency index keys on it.
 * Author `Ley Abierta <bot@leyabierta.es>`, author date today.
 *
 * Idempotent: a restored file has nothing left to add. Dry run is the
 * default; nothing is written without `--apply`. Never pushes. After applying
 * it runs `assertUniqueByNormId` over the repo.
 *
 * Usage:
 *   bun run scripts/ad-hoc/restore-missing-materias.ts --repo PATH \
 *     [--json DIR] [--apply] [--report FILE]
 *
 *   --repo    leyes checkout (default: $REPO_PATH; required otherwise)
 *   --json    JSON cache dir (default: ./data/json)
 *   --apply   write + commit (default: dry run)
 *   --report  also write the per-file plan as JSON to FILE
 *
 * HOW TO RUN IN PRODUCTION: inside the api container (it owns /data/leyes and
 * /data/json), AFTER a daily run has finished Step 3 (so the JSON cache has
 * today's análisis) and while no pipeline is running. `scripts/` is not in the
 * Docker image, so copy it next to `packages/` for the relative imports:
 *
 *   docker cp /opt/leyabierta/code/scripts code-api-1:/app/scripts
 *   docker exec code-api-1 bun run scripts/ad-hoc/restore-missing-materias.ts \
 *     --repo /data/leyes --json /data/json          # dry run: review counts
 *   docker exec code-api-1 bun run scripts/ad-hoc/restore-missing-materias.ts \
 *     --repo /data/leyes --json /data/json --apply
 *
 * Then let Step 1.5 of the next daily run push it (or push by hand).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { GitRepo } from "../../packages/pipeline/src/git/repo.ts";
import type {
	CommitInfo,
	NormAnalisis,
	NormMetadata,
} from "../../packages/pipeline/src/models.ts";
import { assertUniqueByNormId } from "../../packages/pipeline/src/pipeline.ts";
import { SPAIN_JURISDICTION_CODES } from "../../packages/pipeline/src/spain/jurisdictions.ts";
import {
	ANALISIS_KEYS,
	analisisToFrontmatter,
	parseCachedAnalisis,
	parseFrontmatterYaml,
	splitFrontmatter,
} from "../../packages/pipeline/src/transform/analisis.ts";
import { normToFilepath } from "../../packages/pipeline/src/transform/slug.ts";

/** The exact dump options of `renderFrontmatter`. */
const DUMP_OPTIONS: yaml.DumpOptions = {
	lineWidth: -1,
	quotingType: '"',
	forceQuotes: false,
};

/** What the JSON cache knows about a norm. */
export interface CacheEntry {
	/** Where the cache places the file (`<jurisdiction>/<id>.md`). */
	readonly relPath: string;
	readonly analisis: NormAnalisis | undefined;
}

export type SkipReason =
	| "sin frontmatter"
	| "frontmatter no reproducible"
	| "identificador distinto del fichero"
	| "sin caché JSON"
	| "caché en otra jurisdicción"
	| "sin análisis en caché";

export interface FilePlan {
	readonly id: string;
	readonly relPath: string;
	/** Keys that will be added (empty when there's nothing to add). */
	readonly added: string[];
	readonly skip?: SkipReason;
	/** `ultima_actualizacion` as in the file. */
	readonly lastUpdated?: string;
	/** The new file content, when `added` is non-empty and not skipped. */
	readonly content?: string;
}

/**
 * Plan one file: which análisis keys to add and the resulting content.
 * Pure: `cache` is the JSON cache entry for the file's norm, if any.
 */
export function planFile(
	relPath: string,
	markdown: string,
	cache: CacheEntry | undefined,
): FilePlan {
	const id = relPath.split("/").pop()!.replace(/\.md$/, "");
	const base = { id, relPath, added: [] as string[] };
	const parts = splitFrontmatter(markdown);
	if (!parts) return { ...base, skip: "sin frontmatter" };
	const data = parseFrontmatterYaml(parts.yaml);
	if (!data) return { ...base, skip: "sin frontmatter" };
	// Only touch files we can reproduce exactly: then the new frontmatter
	// differs from the old one by the added keys and nothing else.
	if (yaml.dump(data, DUMP_OPTIONS) !== `${parts.yaml}\n`) {
		return { ...base, skip: "frontmatter no reproducible" };
	}
	const last = data.ultima_actualizacion;
	const withDate = {
		...base,
		lastUpdated: last === undefined || last === null ? undefined : String(last),
	};
	if (String(data.identificador ?? "") !== id) {
		return { ...withDate, skip: "identificador distinto del fichero" };
	}
	if (!cache) return { ...withDate, skip: "sin caché JSON" };
	if (cache.relPath !== relPath) {
		return { ...withDate, skip: "caché en otra jurisdicción" };
	}
	if (!cache.analisis) return { ...withDate, skip: "sin análisis en caché" };

	const fromCache = analisisToFrontmatter(cache.analisis);
	const added = ANALISIS_KEYS.filter((k) => !(k in data) && k in fromCache);
	if (added.length === 0) return withDate;

	// Rebuild in the pipeline's key order: everything that isn't análisis
	// keeps its place, then the análisis keys in render order. Existing
	// análisis keys keep their value; only missing ones come from the cache.
	const next: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(data)) {
		if (!(ANALISIS_KEYS as readonly string[]).includes(k)) next[k] = v;
	}
	for (const k of ANALISIS_KEYS) {
		if (k in data) next[k] = data[k];
		else if (k in fromCache) next[k] = fromCache[k];
	}
	const content = `---\n${yaml.dump(next, DUMP_OPTIONS)}---${parts.rest}`;
	return { ...withDate, added: [...added], content };
}

/** Parse a JSON cache object into what `planFile` needs. */
export function cacheEntryFromJson(raw: unknown): CacheEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const m = (raw as Record<string, unknown>).metadata as
		| Record<string, unknown>
		| undefined;
	if (!m || typeof m.id !== "string") return undefined;
	const metadata = {
		id: m.id,
		country: String(m.country ?? ""),
		source: String(m.source ?? ""),
	} as NormMetadata;
	return {
		relPath: normToFilepath(metadata),
		analisis: parseCachedAnalisis(raw),
	};
}

/**
 * Source-Date of the commit a file goes into: today, unless the file's
 * content is dated later (then its own date, so the API never serves it
 * before that date).
 */
export function commitDateFor(plan: FilePlan, today: string): string {
	const d = plan.lastUpdated;
	return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d > today ? d : today;
}

export const isWritable = (p: FilePlan): p is FilePlan & { content: string } =>
	!p.skip && p.content !== undefined;

export function buildRestoreCommit(
	plans: readonly FilePlan[],
	sourceDate: string,
	today: string,
): CommitInfo {
	const counts = ANALISIS_KEYS.map(
		(k) => `  ${k}: ${plans.filter((p) => p.added.includes(k)).length}`,
	);
	const only = plans.length === 1 ? plans[0] : undefined;
	return {
		commitType: "fix-pipeline",
		subject: only
			? `${only.id} — materias y referencias restauradas`
			: `Materias y referencias restauradas en ${plans.length} leyes`,
		body: [
			"El pipeline diario reescribía los ficheros sin los datos de análisis",
			"del BOE (materias, notas y referencias). Se añaden desde la caché JSON",
			"(la misma fuente que la base de datos). Solo cambia el frontmatter:",
			"el texto de las leyes no se toca.",
			"Corrección del pipeline, sin nueva disposición del BOE.",
			"",
			"Campos añadidos (ficheros):",
			...counts,
		].join("\n"),
		trailers: {
			"Source-Date": sourceDate,
			...(only ? { "Norm-Id": only.id } : {}),
		},
		authorName: "Ley Abierta",
		authorEmail: "bot@leyabierta.es",
		authorDate: today,
		filePath: only?.relPath ?? "",
		content: "",
	};
}

export interface ApplyResult {
	readonly commits: string[];
	readonly written: number;
	readonly unchanged: number;
}

/** Write every writable plan, commit per Source-Date group, check invariant. */
export async function applyPlans(
	repoPath: string,
	plans: readonly FilePlan[],
	today: string = new Date().toISOString().slice(0, 10),
): Promise<ApplyResult> {
	const repo = new GitRepo(repoPath, "Ley Abierta", "bot@leyabierta.es");
	const groups = new Map<string, (FilePlan & { content: string })[]>();
	for (const p of plans) {
		if (!isWritable(p)) continue;
		const key = commitDateFor(p, today);
		const list = groups.get(key) ?? [];
		list.push(p);
		groups.set(key, list);
	}
	const commits: string[] = [];
	let written = 0;
	let unchanged = 0;
	// Oldest Source-Date first, so the newest-dated commit ends up on top.
	for (const [sourceDate, group] of [...groups].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const committed: FilePlan[] = [];
		for (const p of group) {
			if (!repo.writeAndAdd(p.relPath, p.content)) {
				unchanged++;
				continue;
			}
			await repo.add(p.relPath);
			committed.push(p);
			written++;
		}
		if (committed.length === 0) continue;
		const sha = await repo.commit(
			buildRestoreCommit(committed, sourceDate, today),
		);
		if (sha) commits.push(sha);
	}
	await assertUniqueByNormId(repoPath);
	return { commits, written, unchanged };
}

/** Plan every `<jurisdiction>/<id>.md` of the repo. */
export function planRepo(
	repoPath: string,
	loadCache: (id: string) => CacheEntry | undefined,
): FilePlan[] {
	const plans: FilePlan[] = [];
	for (const jurisdiction of SPAIN_JURISDICTION_CODES) {
		const dir = join(repoPath, jurisdiction);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).sort()) {
			if (!file.endsWith(".md")) continue;
			const relPath = `${jurisdiction}/${file}`;
			const md = readFileSync(join(repoPath, relPath), "utf-8");
			plans.push(planFile(relPath, md, loadCache(file.slice(0, -3))));
		}
	}
	return plans;
}

export function jsonCacheLoader(jsonDir: string) {
	return (id: string): CacheEntry | undefined => {
		const p = join(jsonDir, `${id}.json`);
		if (!existsSync(p)) return undefined;
		try {
			return cacheEntryFromJson(JSON.parse(readFileSync(p, "utf-8")));
		} catch {
			return undefined;
		}
	};
}

// ─── CLI ───

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
	const repoPath = arg("--repo") ?? process.env.REPO_PATH;
	if (!repoPath) {
		console.error("Falta --repo PATH (o REPO_PATH).");
		process.exit(2);
	}
	const jsonDir = arg("--json") ?? "./data/json";
	const reportPath = arg("--report");
	const apply = process.argv.includes("--apply");

	if (apply) {
		// Refuse to mix our commits with someone else's staged work.
		const staged = execFileSync(
			"git",
			["-C", repoPath, "diff", "--cached", "--name-only"],
			{ encoding: "utf-8" },
		).trim();
		if (staged) {
			console.error(
				`Hay cambios preparados en ${repoPath}; abortando:\n${staged}`,
			);
			process.exit(1);
		}
	}

	const plans = planRepo(repoPath, jsonCacheLoader(jsonDir));
	const writable = plans.filter(isWritable);
	const complete = plans.filter((p) => !p.skip && p.added.length === 0);
	const skipped = plans.filter((p) => p.skip);

	console.log(
		`Repo: ${repoPath}  caché: ${jsonDir}  modo: ${apply ? "APPLY" : "dry-run"}`,
	);
	console.log(`Ficheros revisados: ${plans.length}`);
	console.log(`  a completar:        ${writable.length}`);
	for (const k of ANALISIS_KEYS) {
		const n = writable.filter((p) => p.added.includes(k)).length;
		console.log(`    + ${k.padEnd(24)} ${n}`);
	}
	console.log(`  ya completos:       ${complete.length}`);
	console.log(`  omitidos:           ${skipped.length}`);
	const reasons = new Map<string, FilePlan[]>();
	for (const p of skipped) {
		const list = reasons.get(p.skip!) ?? [];
		list.push(p);
		reasons.set(p.skip!, list);
	}
	for (const [reason, list] of reasons) {
		const sample = list
			.slice(0, 10)
			.map((p) => p.relPath)
			.join(", ");
		console.log(
			`    ${reason}: ${list.length}  (${sample}${list.length > 10 ? ", …" : ""})`,
		);
	}
	const today = new Date().toISOString().slice(0, 10);
	const dates = new Map<string, number>();
	for (const p of writable) {
		const d = commitDateFor(p, today);
		dates.set(d, (dates.get(d) ?? 0) + 1);
	}
	console.log(
		`Commits previstos: ${dates.size} (${[...dates].map(([d, n]) => `Source-Date ${d}: ${n}`).join("; ")})`,
	);

	if (reportPath) {
		writeFileSync(
			reportPath,
			`${JSON.stringify(
				plans.map(({ content: _c, ...p }) => p),
				null,
				2,
			)}\n`,
		);
	}

	if (!apply) {
		console.log("\nDry run: no se ha escrito nada. Usa --apply para corregir.");
		return;
	}
	const result = await applyPlans(repoPath, plans, today);
	console.log(
		`\nFicheros escritos: ${result.written}  sin cambios: ${result.unchanged}  commits: ${result.commits.length}`,
	);
	console.log("assertUniqueByNormId: OK. No se ha hecho push.");
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
