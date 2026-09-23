/**
 * Move laws that sit in the wrong jurisdiction folder of the `leyes` repo.
 *
 * Why it is needed: three 2026 autonomic laws were written into `es/`:
 *   es/BOE-A-2026-10117.md  → es-ri (Ley 2/2026 de La Rioja)
 *   es/BOE-A-2026-12186.md  → es-as (Ley del Principado de Asturias 3/2026)
 *   es/BOE-A-2026-13298.md  → es-as (Ley del Principado de Asturias 4/2026)
 * The pipeline fetched them before the BOE assigned their ELI: `/metadatos`
 * had no `url_eli`, a `BOE-A` id has no regional bulletin prefix, and the
 * jurisdiction resolvers silently fell back to `es` (fixed in the same PR:
 * `resolveJurisdiction` now uses the autonomic `departamento` and throws
 * instead of defaulting). The JSON cache and the DB were re-fetched later and
 * already say es-ri / es-as. The markdown files are the problem: the next
 * time the BOE reforms one of them the pipeline renders it at `es-ri/…`, and
 * `GitRepo.writeAndAdd` throws because the same id exists in `es/` — which
 * would break the daily run. Meanwhile the API (which builds the path from
 * the DB's ELI) cannot find their versions/diffs either.
 *
 * DETECTION is generic, not limited to those three: every
 * `<jurisdiction>/<id>.md` is compared with the DB (`norms.jurisdiction`, the
 * authority CLAUDE.md allows for ad-hoc scripts). A file is misplaced when its
 * folder differs from the DB. Files the DB does not know are resolved from
 * their own frontmatter with `resolveJurisdiction` and only reported. It also
 * reports ids present in more than one folder and files whose `jurisdiccion`
 * frontmatter disagrees with their folder.
 *
 * A misplaced law is moved only when ALL of these agree on the target:
 * the DB row, `resolveJurisdiction` over the DB row, and the JSON cache
 * (`metadata.country` and `resolveJurisdiction` over its metadata). The target
 * path must not exist and the id must live in exactly one folder. Anything
 * else is reported with the reason and left alone.
 *
 * THE MOVE is one commit per law, through `GitRepo.moveNorm`: it `git rm`s the
 * old path and writes the new one via `writeAndAdd`, both staged together, so
 * `assertUniqueByNormId` holds at every commit and `git log --follow` sees a
 * rename (history continuity). The content is kept byte for byte except the
 * frontmatter lines that name the jurisdiction: `pais` / `jurisdiccion` (the
 * web groups laws by `jurisdiccion`) and top-level `fuente` when the cache now
 * has the ELI URL and the file still had the `act.php` fallback.
 *
 * COMMIT: `<título corto> — movida a <jurisdicción> (<nombre>)`, author
 * `Ley Abierta <bot@leyabierta.es>`, GIT_AUTHOR_DATE = today (the fix happens
 * today; backdating would invent a BOE event), trailers `Source-Date` +
 * `Norm-Id`. No `Source-Id`: this is not a BOE disposition and the pipeline's
 * idempotency index keys on Source-Id (the original bootstrap commit keeps
 * it, so the pipeline will not re-bootstrap the law). `Source-Date` = the
 * law's latest reform date: the API (`GitService`) runs `git log -- <path>`
 * WITHOUT --follow and picks versions by Source-Date, so on the new path this
 * commit is the version valid from that date on. All three 2026 laws have a
 * single version, so their full history stays reachable through the API.
 *
 * Idempotent: a moved law is no longer misplaced. Dry run is the default;
 * nothing is written without `--apply`. Never pushes. After applying it runs
 * `assertUniqueByNormId` over the repo.
 *
 * Usage:
 *   bun run scripts/ad-hoc/move-misplaced-norms.ts --repo PATH \
 *     [--db FILE] [--json DIR] [--only ID,ID] [--apply] [--report FILE]
 *
 *   --repo    leyes checkout (default: $REPO_PATH; required otherwise)
 *   --db      SQLite DB, opened read-only (default: $DB_PATH or
 *             ./data/leyabierta.db)
 *   --json    JSON cache dir (default: ./data/json)
 *   --only    comma-separated ids: move only these (the rest is reported)
 *   --apply   move + commit (default: dry run)
 *   --report  also write the findings as JSON to FILE
 *
 * HOW TO RUN IN PRODUCTION: inside the api container (it owns /data/leyes,
 * /data/json and /data/leyabierta.db) while the daily pipeline is NOT
 * running; Step 1.5 of scripts/daily-pipeline.sh pushes the commits on its
 * next run. `scripts/` is not in the Docker image, so copy it next to
 * `packages/` for the relative imports:
 *
 *   docker cp /opt/leyabierta/code/scripts code-api-1:/app/scripts
 *   docker exec code-api-1 bun run scripts/ad-hoc/move-misplaced-norms.ts \
 *     --repo /data/leyes --db /data/leyabierta.db --json /data/json
 *   docker exec code-api-1 bun run scripts/ad-hoc/move-misplaced-norms.ts \
 *     --repo /data/leyes --db /data/leyabierta.db --json /data/json \
 *     --only BOE-A-2026-10117,BOE-A-2026-12186,BOE-A-2026-13298 --apply
 */

import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { GitRepo } from "../../packages/pipeline/src/git/repo.ts";
import type { CommitInfo } from "../../packages/pipeline/src/models.ts";
import { assertUniqueByNormId } from "../../packages/pipeline/src/pipeline.ts";
import { extractShortTitle } from "../../packages/pipeline/src/spain/boe-metadata.ts";
import {
	isSpainJurisdiction,
	jurisdictionFromEli,
	resolveJurisdiction,
	SPAIN_JURISDICTION_CODES,
	SPAIN_JURISDICTIONS,
	type SpainJurisdiction,
} from "../../packages/pipeline/src/spain/jurisdictions.ts";
import { isPlausibleReformDate } from "../../packages/pipeline/src/utils/date.ts";

// ─── Inputs ───

/** What the DB knows about a norm (`norms` row). */
export interface DbNorm {
	readonly id: string;
	readonly jurisdiction: string;
	readonly country: string;
	readonly source: string;
	readonly department: string;
}

/** What the JSON cache knows about a norm (`metadata`). */
export interface CacheNorm {
	readonly id: string;
	readonly country: string;
	readonly source: string;
	readonly department: string;
	readonly shortTitle: string;
}

/** The frontmatter fields this script reads. */
export interface FileFields {
	readonly id: string | undefined;
	readonly title: string;
	readonly country: string | undefined;
	readonly jurisdiction: string | undefined;
	readonly department: string;
	readonly source: string;
	readonly reformDates: readonly string[];
}

function splitFrontmatter(md: string): { yaml: string; end: number } | null {
	if (!md.startsWith("---\n")) return null;
	const end = md.indexOf("\n---", 4);
	if (end === -1) return null;
	return { yaml: md.slice(4, end), end };
}

export function readFileFields(md: string): FileFields | null {
	const parts = splitFrontmatter(md);
	if (!parts) return null;
	const data = yaml.load(parts.yaml, { schema: yaml.CORE_SCHEMA }) as Record<
		string,
		unknown
	> | null;
	if (!data || typeof data !== "object") return null;
	const str = (v: unknown) =>
		v === undefined || v === null ? undefined : String(v);
	const reforms = Array.isArray(data.reformas) ? data.reformas : [];
	return {
		id: str(data.identificador),
		title: str(data.titulo) ?? "",
		country: str(data.pais),
		jurisdiction: str(data.jurisdiccion),
		department: str(data.departamento) ?? "",
		source: str(data.fuente) ?? "",
		reformDates: reforms
			.filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
			.map((r) => String(r.fecha ?? "")),
	};
}

// ─── Detection (pure) ───

export type Status =
	| "movable" // misplaced; every source agrees on the target
	| "blocked" // misplaced, but something disagrees — see reason
	| "unverified"; // not in the DB; frontmatter says it is misplaced

export interface Finding {
	readonly id: string;
	readonly relPath: string;
	readonly folder: SpainJurisdiction;
	/** Where the law belongs (DB, or frontmatter when the DB lacks it). */
	readonly expected: string;
	readonly status: Status;
	readonly reason?: string;
	/** Frontmatter `jurisdiccion`, for the report. */
	readonly fileJurisdiction?: string;
}

export interface ScanResult {
	readonly scanned: number;
	/** Files whose folder disagrees with the canonical jurisdiction. */
	readonly misplaced: Finding[];
	/** Ids found in more than one folder. */
	readonly duplicates: { id: string; folders: string[] }[];
	/** Correct folder, but frontmatter `jurisdiccion` names another one. */
	readonly staleFrontmatter: { relPath: string; jurisdiccion: string }[];
	/** Files the DB does not know. */
	readonly notInDb: string[];
}

const safeResolve = (
	input: Parameters<typeof resolveJurisdiction>[0],
): { ok: string } | { error: string } => {
	try {
		return { ok: resolveJurisdiction(input) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
};

/**
 * Decide where one file belongs. `db` / `cache` are lookups by id; `exists`
 * tells whether a repo-relative path exists.
 */
export function classifyFile(
	relPath: string,
	folder: SpainJurisdiction,
	id: string,
	md: string,
	db: (id: string) => DbNorm | undefined,
	cache: (id: string) => CacheNorm | undefined,
	exists: (relPath: string) => boolean,
	folders: readonly string[],
): Finding | null {
	const file = readFileFields(md);
	const row = db(id);

	if (!row) {
		if (!file) return null;
		const r = safeResolve({
			id,
			source: file.source,
			department: file.department,
			country: file.country,
		});
		if ("ok" in r && r.ok === folder) return null;
		return {
			id,
			relPath,
			folder,
			expected: "ok" in r ? r.ok : "?",
			status: "unverified",
			reason:
				"ok" in r
					? "no está en la BD; solo el frontmatter lo sitúa en otra carpeta"
					: `no está en la BD y el frontmatter no resuelve: ${r.error}`,
			fileJurisdiction: file.jurisdiction,
		};
	}

	if (row.jurisdiction === folder) return null;

	const base = {
		id,
		relPath,
		folder,
		expected: row.jurisdiction,
		fileJurisdiction: file?.jurisdiction,
	};
	const blocked = (reason: string): Finding => ({
		...base,
		status: "blocked",
		reason,
	});

	if (!isSpainJurisdiction(row.jurisdiction)) {
		return blocked(
			`la BD da una jurisdicción desconocida: ${row.jurisdiction}`,
		);
	}
	const fromDb = safeResolve({
		id,
		source: row.source,
		department: row.department,
		country: row.country,
	});
	if (!("ok" in fromDb) || fromDb.ok !== row.jurisdiction) {
		return blocked(
			`norms.jurisdiction=${row.jurisdiction} pero resolveJurisdiction sobre la fila da ${"ok" in fromDb ? fromDb.ok : fromDb.error}`,
		);
	}
	const cached = cache(id);
	if (!cached) return blocked("sin caché JSON para confirmar la jurisdicción");
	const fromCache = safeResolve({
		id,
		source: cached.source,
		department: cached.department,
		country: cached.country,
	});
	if (cached.country !== row.jurisdiction) {
		return blocked(
			`la caché JSON dice metadata.country=${cached.country}, la BD ${row.jurisdiction}`,
		);
	}
	if (!("ok" in fromCache) || fromCache.ok !== row.jurisdiction) {
		return blocked(
			`resolveJurisdiction sobre la caché da ${"ok" in fromCache ? fromCache.ok : fromCache.error}`,
		);
	}
	if (folders.length > 1) {
		return blocked(`está en varias carpetas: ${folders.join(", ")}`);
	}
	if (exists(`${row.jurisdiction}/${id}.md`)) {
		return blocked(`${row.jurisdiction}/${id}.md ya existe`);
	}
	if (!file) return blocked("frontmatter ilegible");
	return { ...base, status: "movable" };
}

/** Scan every `<jurisdiction>/<id>.md` of the repo. */
export function scanRepo(
	repoPath: string,
	db: (id: string) => DbNorm | undefined,
	cache: (id: string) => CacheNorm | undefined,
): ScanResult {
	const files: { folder: SpainJurisdiction; id: string }[] = [];
	const foldersById = new Map<string, string[]>();
	for (const folder of SPAIN_JURISDICTION_CODES) {
		const dir = join(repoPath, folder);
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".md")) continue;
			const id = name.slice(0, -3);
			files.push({ folder, id });
			foldersById.set(id, [...(foldersById.get(id) ?? []), folder]);
		}
	}

	const misplaced: Finding[] = [];
	const staleFrontmatter: ScanResult["staleFrontmatter"] = [];
	const notInDb: string[] = [];
	const exists = (rel: string) => existsSync(join(repoPath, rel));
	for (const { folder, id } of files) {
		const relPath = `${folder}/${id}.md`;
		const md = readFileSync(join(repoPath, relPath), "utf-8");
		if (!db(id)) notInDb.push(relPath);
		const f = classifyFile(
			relPath,
			folder,
			id,
			md,
			db,
			cache,
			exists,
			foldersById.get(id) ?? [folder],
		);
		if (f) {
			misplaced.push(f);
			continue;
		}
		const j = readFileFields(md)?.jurisdiction;
		if (j !== undefined && j !== folder) {
			staleFrontmatter.push({ relPath, jurisdiccion: j });
		}
	}
	const duplicates = [...foldersById]
		.filter(([, folders]) => folders.length > 1)
		.map(([id, folders]) => ({ id, folders }));
	return {
		scanned: files.length,
		misplaced,
		duplicates,
		staleFrontmatter,
		notInDb,
	};
}

// ─── Move (content + commit) ───

/**
 * The file with its jurisdiction frontmatter lines pointing at `target`:
 * top-level `pais` and `jurisdiccion`, and `fuente` when the file lacks the
 * ELI URL that `eliSource` provides. Everything else is kept byte for byte.
 */
export function rewriteJurisdiction(
	md: string,
	target: string,
	eliSource: string | undefined,
): string {
	const parts = splitFrontmatter(md);
	if (!parts) throw new Error("fichero sin frontmatter");
	const line = (key: string, value: string) =>
		yaml.dump({ [key]: value }, { lineWidth: -1 }).trimEnd();
	let fm = parts.yaml
		.replace(/^pais: .*$/m, line("pais", target))
		.replace(/^jurisdiccion: .*$/m, line("jurisdiccion", target));
	const fileEli = (() => {
		try {
			return jurisdictionFromEli(fm.match(/^fuente: (.*)$/m)?.[1]);
		} catch {
			return null;
		}
	})();
	if (
		eliSource &&
		fileEli === null &&
		jurisdictionFromEli(eliSource) === target
	) {
		fm = fm.replace(/^fuente: .*$/m, line("fuente", eliSource));
	}
	return `---\n${fm}${md.slice(parts.end)}`;
}

/** Latest plausible reform date of the file (the version it holds). */
export function latestReformDate(
	dates: readonly string[],
	now: Date = new Date(),
): string | undefined {
	let max: string | undefined;
	for (const d of dates) {
		if (isPlausibleReformDate(d, now) && (max === undefined || d > max))
			max = d;
	}
	return max;
}

export function buildMoveCommit(
	finding: Finding,
	shortTitle: string,
	sourceDate: string | undefined,
	today: string,
): CommitInfo {
	const target = finding.expected as SpainJurisdiction;
	const name = SPAIN_JURISDICTIONS[target];
	return {
		// Not "correccion" (a BOE corrección de errores): a pipeline fix.
		commitType: "fix-pipeline",
		subject: `${shortTitle} — movida a ${target} (${name})`,
		body: [
			`La ley estaba en ${finding.folder}/ por error: el pipeline la descargó antes de`,
			"que el BOE le asignara su ELI y la jurisdicción cayó en «es» por defecto.",
			`Se mueve a ${target}/, su jurisdicción (${name}), sin cambiar el texto.`,
			"Corrección del pipeline, sin nueva disposición del BOE.",
			"",
			`Norma: ${finding.id}`,
			`Antes: ${finding.relPath}`,
			`Ahora: ${target}/${finding.id}.md`,
		].join("\n"),
		trailers: {
			...(sourceDate ? { "Source-Date": sourceDate } : {}),
			"Norm-Id": finding.id,
		},
		authorName: "Ley Abierta",
		authorEmail: "bot@leyabierta.es",
		authorDate: today,
		filePath: `${target}/${finding.id}.md`,
		content: "",
	};
}

export interface ApplyResult {
	readonly moved: string[];
}

/** Move + commit every movable finding, then check the invariant. */
export async function applyMoves(
	repoPath: string,
	findings: readonly Finding[],
	cache: (id: string) => CacheNorm | undefined,
	today: string = new Date().toISOString().slice(0, 10),
	now: Date = new Date(),
): Promise<ApplyResult> {
	const repo = new GitRepo(repoPath, "Ley Abierta", "bot@leyabierta.es");
	const moved: string[] = [];
	for (const f of findings) {
		if (f.status !== "movable") continue;
		const cached = cache(f.id);
		const md = readFileSync(join(repoPath, f.relPath), "utf-8");
		const fields = readFileFields(md);
		const content = rewriteJurisdiction(md, f.expected, cached?.source);
		const toRel = `${f.expected}/${f.id}.md`;
		await repo.moveNorm(f.relPath, toRel, content);
		const shortTitle =
			cached?.shortTitle || extractShortTitle(fields?.title ?? f.id);
		const sha = await repo.commit(
			buildMoveCommit(
				f,
				shortTitle,
				latestReformDate(fields?.reformDates ?? [], now),
				today,
			),
		);
		if (sha) moved.push(f.id);
	}
	await assertUniqueByNormId(repoPath);
	return { moved };
}

// ─── Sources ───

export function dbLoader(dbPath: string): (id: string) => DbNorm | undefined {
	const db = new Database(dbPath, { readonly: true });
	const rows = db
		.query<
			{
				id: string;
				jurisdiction: string;
				country: string;
				source_url: string;
				department: string;
			},
			[]
		>("SELECT id, jurisdiction, country, source_url, department FROM norms")
		.all();
	db.close();
	const byId = new Map(
		rows.map((r) => [
			r.id,
			{
				id: r.id,
				jurisdiction: r.jurisdiction,
				country: r.country,
				source: r.source_url,
				department: r.department,
			},
		]),
	);
	return (id) => byId.get(id);
}

export function jsonCacheLoader(
	jsonDir: string,
): (id: string) => CacheNorm | undefined {
	return (id) => {
		const p = join(jsonDir, `${id}.json`);
		if (!existsSync(p)) return undefined;
		const m = JSON.parse(readFileSync(p, "utf-8")).metadata ?? {};
		return {
			id: String(m.id ?? id),
			country: String(m.country ?? ""),
			source: String(m.source ?? ""),
			department: String(m.department ?? ""),
			shortTitle: String(m.shortTitle ?? ""),
		};
	};
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
	const dbPath = arg("--db") ?? process.env.DB_PATH ?? "./data/leyabierta.db";
	if (!existsSync(dbPath)) {
		console.error(`No existe la BD ${dbPath} (usa --db).`);
		process.exit(2);
	}
	const jsonDir = arg("--json") ?? "./data/json";
	const reportPath = arg("--report");
	const onlyArg = arg("--only");
	const only = onlyArg
		? new Set(
				onlyArg
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			)
		: undefined;
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

	const cache = jsonCacheLoader(jsonDir);
	const scan = scanRepo(repoPath, dbLoader(dbPath), cache);
	const findings = scan.misplaced.map((f) =>
		only && f.status === "movable" && !only.has(f.id)
			? { ...f, status: "blocked" as const, reason: "no está en --only" }
			: f,
	);

	console.log(`Repo: ${repoPath}  modo: ${apply ? "APPLY" : "dry-run"}`);
	console.log(
		`Ficheros revisados: ${scan.scanned}. En carpeta equivocada: ${findings.length}. ` +
			`Sin fila en la BD: ${scan.notInDb.length}.\n`,
	);
	const row = (f: Finding) =>
		`  ${f.id.padEnd(22)} ${f.folder.padEnd(6)} -> ${f.expected.padEnd(6)} ` +
		`(frontmatter: ${f.fileJurisdiction ?? "?"})${f.reason ? `  <${f.reason}>` : ""}`;
	for (const status of ["movable", "blocked", "unverified"] as const) {
		const list = findings.filter((f) => f.status === status);
		console.log(`${status}: ${list.length}`);
		for (const f of list) console.log(row(f));
	}
	console.log(`\nIds en varias carpetas: ${scan.duplicates.length}`);
	for (const d of scan.duplicates)
		console.log(`  ${d.id}: ${d.folders.join(", ")}`);
	console.log(
		`Frontmatter «jurisdiccion» distinto de la carpeta (carpeta correcta): ${scan.staleFrontmatter.length}`,
	);
	for (const s of scan.staleFrontmatter)
		console.log(`  ${s.relPath}: ${s.jurisdiccion}`);

	if (reportPath) {
		writeFileSync(
			reportPath,
			`${JSON.stringify({ ...scan, misplaced: findings }, null, 2)}\n`,
		);
	}

	if (!apply) {
		console.log("\nDry run: no se ha escrito nada. Usa --apply para mover.");
		return;
	}
	const result = await applyMoves(repoPath, findings, cache);
	console.log(`\nMovidas: ${result.moved.length} (${result.moved.join(", ")})`);
	console.log("assertUniqueByNormId: OK. No se ha hecho push.");
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}
