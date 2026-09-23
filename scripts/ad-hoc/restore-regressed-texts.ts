/**
 * Restore laws whose text in the `leyes` repo regressed to an older version
 * (A5b — cleanup after PR #170).
 *
 * Why it is needed: before PR #170, when the BOE added a reform to a law dated
 * EARLIER than reforms we had already committed, `commitNorm` /
 * `commitNormsChronologically` re-rendered the whole file at that older date.
 * The file kept the full `reformas` list but its text — and
 * `ultima_actualizacion` — went back in time. Example: Estatuto de los
 * Trabajadores (BOE-A-2015-11430), commit 93f61f1 in leyes (art. 45, dated
 * 2023-03-01) undid the 2024–2025 changes to arts. 4 and 12. PR #170
 * (`resolveRenderDate`) stops new regressions; this script repairs the files
 * that were already wrong. The DB/API were never affected (they are built from
 * the JSON cache, not from the markdown). A regressed law also heals by itself
 * the next time the BOE reforms it, but many of them are rarely reformed.
 *
 * DETECTION uses the file alone, so it does not depend on any cache: a file is
 * regressed when its own frontmatter lists a plausible reform later than its
 * `ultima_actualizacion`. The pipeline renders a law at its latest reform date
 * (and since PR #170 never moves it back), so a correct file never looks like
 * that. Implausible dates (the BOE's `2929-11-19`) are ignored on both sides,
 * as `resolveRenderDate` does: a file rendered AT 2929 already contains every
 * version, and a 2929 entry in `reformas` is not a date to render at.
 *
 * REGENERATION re-renders a flagged file with the pipeline's own functions:
 *   --source boe (default): `fetchNorm` from the BOE, i.e. exactly what the
 *     daily `pipeline bootstrap` renders (paragraph CSS classes, metadata). The
 *     fetch writes its JSON into a throwaway temp dir, never into data/json.
 *   --source cache: `jsonToNorm` from data/json, like `pipeline rebuild`. The
 *     JSON cache drops paragraph CSS classes, so headings come out as plain
 *     paragraphs where the file had `####` — use it only offline/for testing.
 * `materias` / `notas` / `referencias_*` are carried over from the file itself,
 * so the correction commit changes the text and `ultima_actualizacion` only.
 * It is rendered at the law's latest plausible reform date, written through
 * `GitRepo.writeAndAdd` and committed. A law is only regenerated when:
 *   - the source has EXACTLY the same reforms as the file. If the source is
 *     newer (a reform the file lacks) the law is left alone: writing it here
 *     would make the pipeline skip that reform's own commit — and that reform's
 *     commit will re-render and heal the file anyway. If it is older, we can't
 *     judge it. Both are reported.
 *   - the JSON cache (the jurisdiction authority for ad-hoc scripts, see
 *     CLAUDE.md) and the source both place the law at the path it already has.
 *     This script never moves or creates files.
 *
 * COMMIT: `<título corto> — texto restaurado a la versión vigente`, author
 * `Ley Abierta <bot@leyabierta.es>`, trailers `Source-Date` + `Norm-Id`. No
 * `Source-Id`: this is not a BOE disposition, and the pipeline's idempotency
 * index keys on Source-Id.
 *   - GIT_AUTHOR_DATE = today. The correction happens today; backdating it to
 *     the reform would invent a second BOE event on a date that already has
 *     its own commit, and hide when the fix was made.
 *   - Source-Date = the latest reform date. The API (`GitService.getFileAtDate`
 *     and `diff`) picks versions by Source-Date, walking newest-first; with it
 *     the corrected text is served for every date from that reform onward.
 *
 * Idempotent: a corrected file no longer matches the detection rule, and
 * `writeAndAdd` reports "unchanged" for identical content. Dry run is the
 * default; nothing is written without `--apply`. Never pushes. After applying
 * it runs `assertUniqueByNormId` over the repo.
 *
 * Usage:
 *   bun run scripts/ad-hoc/restore-regressed-texts.ts --repo PATH \
 *     [--source boe|cache] [--json DIR] [--apply] [--report FILE]
 *
 *   --repo    leyes checkout (default: $REPO_PATH; required otherwise)
 *   --source  where to re-render from (default: boe)
 *   --json    JSON cache dir (default: ./data/json)
 *   --apply   write + commit the flagged files (default: dry run)
 *   --report  also write the findings as JSON to FILE
 *
 * HOW TO RUN IN PRODUCTION: inside the api container (it owns /data/leyes and
 * /data/json) while the daily pipeline is NOT running, then let Step 1.5 of
 * scripts/daily-pipeline.sh push on its next run. `scripts/` is not in the
 * Docker image, so copy it next to `packages/` for the relative imports:
 *
 *   docker cp /opt/leyabierta/code/scripts code-api-1:/app/scripts
 *   docker exec code-api-1 bun run scripts/ad-hoc/restore-regressed-texts.ts \
 *     --repo /data/leyes                      # dry run: review the list
 *   docker exec code-api-1 bun run scripts/ad-hoc/restore-regressed-texts.ts \
 *     --repo /data/leyes --apply
 *
 * Full procedure and trade-offs: the PR that added this script.
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
import yaml from "js-yaml";
import { getCountry } from "../../packages/pipeline/src/country.ts";
import { GitRepo } from "../../packages/pipeline/src/git/repo.ts";
import type {
	CommitInfo,
	Norm,
	NormAnalisis,
} from "../../packages/pipeline/src/models.ts";
import {
	assertUniqueByNormId,
	fetchNorm,
} from "../../packages/pipeline/src/pipeline.ts";
import { SPAIN_JURISDICTION_CODES } from "../../packages/pipeline/src/spain/jurisdictions.ts";
import { jsonToNorm } from "../../packages/pipeline/src/transform/json-cache.ts";
import { renderNormAtDate } from "../../packages/pipeline/src/transform/markdown.ts";
import { normToFilepath } from "../../packages/pipeline/src/transform/slug.ts";
import { isPlausibleReformDate } from "../../packages/pipeline/src/utils/date.ts";
// Registers the "es" country (client + parsers) used by --source boe.
import "../../packages/pipeline/src/spain/index.ts";

// ─── Detection (pure, file-only) ───

export interface FileFrontmatter {
	readonly lastUpdated: string | undefined;
	readonly reforms: readonly { date: string; source: string }[];
	/** materias / notas / referencias as they are in the file, if any. */
	readonly analisis: NormAnalisis | undefined;
}

function splitFrontmatter(
	markdown: string,
): { yaml: string; body: string } | null {
	if (!markdown.startsWith("---\n")) return null;
	const end = markdown.indexOf("\n---", 4);
	if (end === -1) return null;
	return { yaml: markdown.slice(4, end), body: markdown.slice(end + 4) };
}

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.map((x) => String(x)) : [];
const refs = (v: unknown) =>
	(Array.isArray(v) ? v : [])
		.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
		.map((r) => ({
			normId: String(r.norma ?? ""),
			relation: String(r.relacion ?? ""),
			text: String(r.texto ?? ""),
		}));

/** Parse the fields we need from a leyes markdown file's frontmatter. */
export function parseFileFrontmatter(markdown: string): FileFrontmatter | null {
	const parts = splitFrontmatter(markdown);
	if (!parts) return null;
	// CORE_SCHEMA: no implicit timestamps, so dates stay strings whether or
	// not the dumper quoted them.
	const data = yaml.load(parts.yaml, { schema: yaml.CORE_SCHEMA }) as Record<
		string,
		unknown
	> | null;
	if (!data || typeof data !== "object") return null;
	const reforms = (Array.isArray(data.reformas) ? data.reformas : [])
		.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
		.map((r) => ({
			date: String(r.fecha ?? ""),
			source: String(r.fuente ?? ""),
		}));
	const hasAnalisis = [
		"materias",
		"notas",
		"referencias_anteriores",
		"referencias_posteriores",
	].some((k) => k in data);
	const last = data.ultima_actualizacion;
	return {
		lastUpdated: last === undefined || last === null ? undefined : String(last),
		reforms,
		analisis: hasAnalisis
			? {
					materias: strings(data.materias),
					notas: strings(data.notas),
					referencias: {
						anteriores: refs(data.referencias_anteriores),
						posteriores: refs(data.referencias_posteriores),
					},
				}
			: undefined,
	};
}

/**
 * Latest plausible reform date — the date the pipeline renders the law at
 * once all its reforms are committed. Undefined if no date is plausible.
 */
export function latestPlausibleDate(
	dates: Iterable<string>,
	now: Date = new Date(),
): string | undefined {
	let max: string | undefined;
	for (const d of dates) {
		if (isPlausibleReformDate(d, now) && (max === undefined || d > max)) {
			max = d;
		}
	}
	return max;
}

/**
 * The detection rule: the date the file should be rendered at, or undefined
 * if it is fine. A file whose `ultima_actualizacion` is a well-formed date at
 * or past every plausible reform (including the BOE's 2929-11-19) already
 * contains every version, so it is not a regression.
 */
export function regressedRenderDate(
	fm: FileFrontmatter,
	now: Date = new Date(),
): string | undefined {
	const expected = latestPlausibleDate(
		fm.reforms.map((r) => r.date),
		now,
	);
	if (expected === undefined) return undefined;
	const current = fm.lastUpdated;
	if (current && /^\d{4}-\d{2}-\d{2}$/.test(current) && current >= expected) {
		return undefined;
	}
	return expected;
}

export interface Finding {
	readonly id: string;
	readonly jurisdiction: string;
	readonly relPath: string;
	/** `ultima_actualizacion` in the file now. */
	readonly renderedAt: string | undefined;
	/** Latest plausible reform date listed in the file. */
	readonly expected: string;
}

/** Classify one file. Returns null when it is not regressed. */
export function inspectFile(
	relPath: string,
	markdown: string,
	now: Date = new Date(),
): Finding | null {
	const fm = parseFileFrontmatter(markdown);
	if (!fm) return null;
	const expected = regressedRenderDate(fm, now);
	if (expected === undefined) return null;
	const [jurisdiction = "", file = ""] = relPath.split("/");
	return {
		id: file.replace(/\.md$/, ""),
		jurisdiction,
		relPath,
		renderedAt: fm.lastUpdated,
		expected,
	};
}

/** Scan every `<jurisdiction>/<id>.md` of the repo. */
export function scanRepo(
	repoPath: string,
	now: Date = new Date(),
): { scanned: number; findings: Finding[] } {
	const findings: Finding[] = [];
	let scanned = 0;
	for (const jurisdiction of SPAIN_JURISDICTION_CODES) {
		const dir = join(repoPath, jurisdiction);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir).sort()) {
			if (!file.endsWith(".md")) continue;
			scanned++;
			const relPath = `${jurisdiction}/${file}`;
			const md = readFileSync(join(repoPath, relPath), "utf-8");
			const f = inspectFile(relPath, md, now);
			if (f) findings.push(f);
		}
	}
	return { scanned, findings };
}

// ─── Planning (pure) ───

export type SourceState =
	| "match" // same reforms: safe to regenerate
	| "missing" // source has no such law
	| "source-older" // file lists reforms the source lacks
	| "source-newer"; // source lists reforms the file lacks

const reformKey = (date: string, source: string) => `${date}|${source}`;

/** Compare the file's reforms with the source norm's reforms. */
export function compareReforms(
	fm: FileFrontmatter,
	norm: Norm | undefined,
): SourceState {
	if (!norm) return "missing";
	const src = new Set(norm.reforms.map((r) => reformKey(r.date, r.normId)));
	const file = new Set(fm.reforms.map((r) => reformKey(r.date, r.source)));
	for (const k of file) if (!src.has(k)) return "source-older";
	for (const k of src) if (!file.has(k)) return "source-newer";
	return "match";
}

export interface Plan extends Finding {
	readonly state: SourceState;
	/** Why a `match` law is still not regenerated (path disagreement). */
	readonly skipReason?: string;
	/** Rendering at `expected` instead of `renderedAt` changes the legal text. */
	readonly textChanged?: boolean;
	/** Rendering the source at `renderedAt` reproduces the current body. */
	readonly reproduces?: boolean;
	/** The corrected file, when regenerable. */
	readonly content?: string;
	/** Last commit that touched the file (the one that regressed it). */
	commit?: string;
}

/**
 * Decide what to do with one finding. `source` is the norm to render from;
 * `cacheNorm` is the JSON cache entry, used only as the jurisdiction check.
 */
export function planFinding(
	finding: Finding,
	markdown: string,
	source: Norm | undefined,
	cacheNorm: Norm | undefined,
): Plan {
	const fm = parseFileFrontmatter(markdown);
	if (!fm) return { ...finding, state: "missing" };
	const state = compareReforms(fm, source);
	if (state !== "match" || !source) return { ...finding, state };

	for (const [label, norm] of [
		["caché JSON", cacheNorm],
		["fuente", source],
	] as const) {
		if (!norm) {
			return {
				...finding,
				state,
				skipReason: `sin ${label} para comprobar la ruta`,
			};
		}
		const rel = normToFilepath(norm.metadata);
		if (rel !== finding.relPath) {
			return {
				...finding,
				state,
				skipReason: `la ${label} lo sitúa en ${rel}, el fichero está en ${finding.relPath}`,
			};
		}
	}

	const render = (date: string) =>
		renderNormAtDate(
			source.metadata,
			source.blocks,
			date,
			source.reforms,
			fm.analisis,
		);
	const content = render(finding.expected);
	const bodyOf = (md: string) => splitFrontmatter(md)?.body ?? md;
	const old = finding.renderedAt ? bodyOf(render(finding.renderedAt)) : "";
	return {
		...finding,
		state,
		textChanged: old !== bodyOf(content),
		reproduces: old === bodyOf(markdown),
		content,
	};
}

// ─── Regeneration ───

export function buildCorrectionCommit(
	norm: Pick<Norm, "metadata">,
	plan: Plan,
	today: string,
): CommitInfo {
	const { metadata } = norm;
	return {
		commitType: "correccion",
		subject: `${metadata.shortTitle} — texto restaurado a la versión vigente`,
		body: [
			`El fichero estaba generado a fecha ${plan.renderedAt ?? "(sin fecha)"} aunque su última`,
			`reforma es del ${plan.expected}: una reforma que el BOE añadió tarde lo`,
			"devolvió a un texto antiguo. Se regenera a la versión vigente.",
			"Corrección del pipeline, sin nueva disposición del BOE.",
			"",
			`Norma: ${metadata.id}`,
			`Fecha: ${plan.expected}`,
			`Fuente: ${metadata.source}`,
		].join("\n"),
		trailers: {
			"Source-Date": plan.expected,
			"Norm-Id": metadata.id,
		},
		authorName: "Ley Abierta",
		authorEmail: "bot@leyabierta.es",
		authorDate: today,
		filePath: plan.relPath,
		content: plan.content ?? "",
	};
}

/** A plan that can be written: reforms match and the path checks passed. */
export const isRegenerable = (p: Plan): p is Plan & { content: string } =>
	p.state === "match" && !p.skipReason && p.content !== undefined;

export interface ApplyResult {
	readonly committed: string[];
	readonly unchanged: string[];
}

/** Write + commit every regenerable plan, then check the invariant. */
export async function applyPlans(
	repoPath: string,
	plans: readonly Plan[],
	sources: ReadonlyMap<string, Pick<Norm, "metadata">>,
	today: string = new Date().toISOString().slice(0, 10),
): Promise<ApplyResult> {
	const repo = new GitRepo(repoPath, "Ley Abierta", "bot@leyabierta.es");
	const committed: string[] = [];
	const unchanged: string[] = [];
	for (const p of plans) {
		if (!isRegenerable(p)) continue;
		const norm = sources.get(p.id);
		if (!norm) continue;
		if (!repo.writeAndAdd(p.relPath, p.content)) {
			unchanged.push(p.id);
			continue;
		}
		await repo.add(p.relPath);
		const sha = await repo.commit(buildCorrectionCommit(norm, p, today));
		if (sha) committed.push(p.id);
	}
	await assertUniqueByNormId(repoPath);
	return { committed, unchanged };
}

// ─── Sources ───

export function jsonCacheLoader(jsonDir: string) {
	return (id: string): Norm | undefined => {
		const p = join(jsonDir, `${id}.json`);
		if (!existsSync(p)) return undefined;
		return jsonToNorm(JSON.parse(readFileSync(p, "utf-8")));
	};
}

/** Fetch from the BOE like `pipeline bootstrap`, into a throwaway data dir. */
async function fetchFromBoe(
	ids: readonly string[],
): Promise<Map<string, Norm>> {
	const country = getCountry("es");
	const client = country.client();
	const textParser = country.textParser();
	const metadataParser = country.metadataParser();
	const scratch = mkdtempSync(join(tmpdir(), "restore-regressed-"));
	const out = new Map<string, Norm>();
	try {
		for (const id of ids) {
			try {
				const norm = await fetchNorm(
					id,
					client,
					textParser,
					metadataParser,
					scratch,
				);
				if (norm) out.set(id, norm);
			} catch (err) {
				console.warn(`  ✗ ${id}: ${err instanceof Error ? err.message : err}`);
			}
		}
	} finally {
		await client.close();
		rmSync(scratch, { recursive: true, force: true });
	}
	return out;
}

// ─── CLI ───

function git(repoPath: string, args: string[]): string {
	return execFileSync("git", ["-C", repoPath, ...args], {
		encoding: "utf-8",
	}).trim();
}

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
	const sourceKind = arg("--source") ?? "boe";
	if (sourceKind !== "boe" && sourceKind !== "cache") {
		console.error(`--source debe ser boe o cache, no ${sourceKind}`);
		process.exit(2);
	}
	const reportPath = arg("--report");
	const apply = process.argv.includes("--apply");

	if (apply) {
		// Refuse to mix our commits with someone else's staged work.
		const staged = git(repoPath, ["diff", "--cached", "--name-only"]);
		if (staged) {
			console.error(
				`Hay cambios preparados en ${repoPath}; abortando:\n${staged}`,
			);
			process.exit(1);
		}
	}

	const { scanned, findings } = scanRepo(repoPath);
	const loadCache = jsonCacheLoader(jsonDir);
	const sources =
		sourceKind === "boe"
			? await fetchFromBoe(findings.map((f) => f.id))
			: new Map(
					findings.flatMap((f) => {
						const n = loadCache(f.id);
						return n ? [[f.id, n] as const] : [];
					}),
				);

	const plans: Plan[] = findings.map((f) => {
		const md = readFileSync(join(repoPath, f.relPath), "utf-8");
		const plan = planFinding(f, md, sources.get(f.id), loadCache(f.id));
		try {
			plan.commit = git(repoPath, [
				"log",
				"-1",
				"--format=%h %as %s",
				"--",
				f.relPath,
			]);
		} catch {}
		return plan;
	});

	const fixable = plans.filter(isRegenerable);
	const rest = plans.filter((p) => !isRegenerable(p));
	console.log(
		`Repo: ${repoPath}  fuente: ${sourceKind}  modo: ${apply ? "APPLY" : "dry-run"}`,
	);
	console.log(
		`Ficheros revisados: ${scanned}. Con texto retrasado: ${findings.length}.\n`,
	);
	const row = (p: Plan) =>
		`  ${p.id.padEnd(22)} ${p.jurisdiction.padEnd(6)} ${String(p.renderedAt).padEnd(10)} -> ${p.expected}  ` +
		`${p.textChanged === undefined ? "" : p.textChanged ? "[texto]     " : "[solo fecha]"} ` +
		`${p.reproduces === false ? "(no reproduce el fichero) " : ""}${p.commit ?? ""}`;
	console.log(`Regenerables: ${fixable.length}`);
	for (const p of fixable) console.log(row(p));
	console.log(`\nNo regenerables: ${rest.length}`);
	for (const p of rest) console.log(`${row(p)}  <${p.skipReason ?? p.state}>`);

	if (reportPath) {
		const report = plans.map(({ content: _c, ...p }) => p);
		writeFileSync(
			reportPath,
			`${JSON.stringify({ scanned, source: sourceKind, plans: report }, null, 2)}\n`,
		);
	}

	if (!apply) {
		console.log("\nDry run: no se ha escrito nada. Usa --apply para corregir.");
		return;
	}
	const result = await applyPlans(repoPath, plans, sources);
	console.log(
		`\nCommits: ${result.committed.length}  sin cambios: ${result.unchanged.length}  no regenerables: ${rest.length}`,
	);
	console.log("assertUniqueByNormId: OK. No se ha hecho push.");
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
