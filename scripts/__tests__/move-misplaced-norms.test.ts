/**
 * scripts/ad-hoc/move-misplaced-norms.ts — detection and the one-commit move
 * of laws that sit in the wrong jurisdiction folder of `leyes`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../../packages/api/src/services/git.ts";
import { GitRepo } from "../../packages/pipeline/src/git/repo.ts";
import {
	applyMoves,
	type CacheNorm,
	classifyFile,
	type DbNorm,
	readFileFields,
	rewriteJurisdiction,
	scanRepo,
} from "../ad-hoc/move-misplaced-norms.ts";

const ID = "BOE-A-2026-10117";
const ELI = "https://www.boe.es/eli/es-ri/l/2026/04/28/2";
const ACT = `https://www.boe.es/buscar/act.php?id=${ID}`;
const NOW = new Date("2026-09-23T00:00:00Z");

/** The file as the pipeline wrote it in es/ (no ELI yet). */
const BODY = Array.from(
	{ length: 30 },
	(_, i) => `##### Artículo ${i + 1}.\n\nTexto del artículo ${i + 1}.\n`,
).join("\n");
const FILE = `---
titulo: Ley 2/2026, de 28 de abril, de simplificación administrativa, mercado abierto y calidad normativa
identificador: ${ID}
pais: es
jurisdiccion: es
rango: ley
fecha_publicacion: "2026-05-11"
ultima_actualizacion: "2026-04-29"
estado: vigente
departamento: Comunidad Autónoma de La Rioja
fuente: ${ACT}
articulos: 30
reformas:
  - fecha: "2026-04-29"
    fuente: ${ID}
---

# Ley 2/2026

${BODY}`;

const DB_ROW: DbNorm = {
	id: ID,
	jurisdiction: "es-ri",
	country: "es-ri",
	source: ELI,
	department: "Comunidad Autónoma de La Rioja",
};
const CACHE: CacheNorm = {
	id: ID,
	country: "es-ri",
	source: ELI,
	department: "Comunidad Autónoma de La Rioja",
	shortTitle: "Ley 2/2026",
};

const one =
	<T>(v: T) =>
	(id: string) =>
		id === ID ? v : undefined;
const none = () => undefined;
const nothingExists = () => false;

describe("rewriteJurisdiction", () => {
	test("changes pais, jurisdiccion and the top-level fuente only", () => {
		const out = rewriteJurisdiction(FILE, "es-ri", ELI);
		const f = readFileFields(out);
		expect(f?.country).toBe("es-ri");
		expect(f?.jurisdiction).toBe("es-ri");
		expect(f?.source).toBe(ELI);
		// The reform entry's own `fuente` is untouched, and so is the body.
		expect(out).toContain(`    fuente: ${ID}\n`);
		expect(out.slice(out.indexOf("\n---\n"))).toBe(
			FILE.slice(FILE.indexOf("\n---\n")),
		);
		const changed = out.split("\n").filter((l, i) => l !== FILE.split("\n")[i]);
		expect(changed).toEqual([
			"pais: es-ri",
			"jurisdiccion: es-ri",
			`fuente: ${ELI}`,
		]);
	});

	test("keeps fuente when the cache has no ELI for the target", () => {
		const out = rewriteJurisdiction(FILE, "es-ri", ACT);
		expect(readFileFields(out)?.source).toBe(ACT);
		expect(
			readFileFields(
				rewriteJurisdiction(
					FILE,
					"es-ri",
					"https://www.boe.es/eli/es-as/l/2026/1/1/1",
				),
			)?.source,
		).toBe(ACT);
	});
});

describe("classifyFile", () => {
	const classify = (
		overrides: {
			db?: (id: string) => DbNorm | undefined;
			cache?: (id: string) => CacheNorm | undefined;
			exists?: (rel: string) => boolean;
			folders?: string[];
			folder?: "es" | "es-ri";
		} = {},
	) => {
		const folder = overrides.folder ?? "es";
		return classifyFile(
			`${folder}/${ID}.md`,
			folder,
			ID,
			FILE,
			overrides.db ?? one(DB_ROW),
			overrides.cache ?? one(CACHE),
			overrides.exists ?? nothingExists,
			overrides.folders ?? [folder],
		);
	};

	test("movable when DB, resolver and JSON cache agree", () => {
		expect(classify()).toMatchObject({
			status: "movable",
			folder: "es",
			expected: "es-ri",
			fileJurisdiction: "es",
		});
	});

	test("a file already in its DB folder is fine", () => {
		expect(classify({ folder: "es-ri" })).toBeNull();
	});

	test("blocked without cache, with a disagreeing cache, or a stale DB row", () => {
		expect(classify({ cache: none })?.reason).toMatch(/sin caché/);
		expect(
			classify({ cache: one({ ...CACHE, country: "es" }) })?.reason,
		).toMatch(/metadata.country=es/);
		expect(
			classify({
				db: one({
					...DB_ROW,
					source: "https://www.boe.es/eli/es-as/l/1/1/1/1",
				}),
			})?.reason,
		).toMatch(/resolveJurisdiction sobre la fila da es-as/);
	});

	test("blocked when the target exists or the id is in several folders", () => {
		expect(classify({ exists: () => true })?.reason).toMatch(/ya existe/);
		expect(classify({ folders: ["es", "es-ri"] })).toMatchObject({
			status: "blocked",
		});
	});

	test("not in the DB: resolved from the frontmatter, reported only", () => {
		expect(classify({ db: none })).toMatchObject({
			status: "unverified",
			expected: "es-ri",
		});
	});
});

describe("scan + applyMoves on a real repo", () => {
	let dir: string;
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "move-misplaced-"));
		const repo = new GitRepo(dir, "Ley Abierta", "bot@leyabierta.es");
		await repo.init();
		const rel = `es/${ID}.md`;
		repo.writeAndAdd(rel, FILE);
		await repo.add(rel);
		await repo.commit({
			commitType: "bootstrap",
			subject: "Ley 2/2026 — publicación original (2026)",
			body: "",
			trailers: {
				"Source-Id": ID,
				"Source-Date": "2026-04-29",
				"Norm-Id": ID,
			},
			authorName: "Ley Abierta",
			authorEmail: "bot@leyabierta.es",
			authorDate: "2026-04-29",
			filePath: rel,
			content: FILE,
		});
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("moves in one commit, keeps history, and a re-scan is clean", async () => {
		const scan = scanRepo(dir, one(DB_ROW), one(CACHE));
		expect(scan.scanned).toBe(1);
		expect(scan.misplaced.map((f) => [f.id, f.status])).toEqual([
			[ID, "movable"],
		]);

		const result = await applyMoves(
			dir,
			scan.misplaced,
			one(CACHE),
			"2026-09-23",
			NOW,
		);
		expect(result.moved).toEqual([ID]);
		expect(existsSync(join(dir, `es/${ID}.md`))).toBe(false);
		expect(readFileSync(join(dir, `es-ri/${ID}.md`), "utf-8")).toBe(
			rewriteJurisdiction(FILE, "es-ri", ELI),
		);
		expect(git("status", "--porcelain")).toBe("");

		const head = git(
			"log",
			"-1",
			"--format=%an <%ae>|%ad|%s%n%B",
			"--date=short",
		);
		expect(head).toContain(
			"Ley Abierta <bot@leyabierta.es>|2026-09-23|Ley 2/2026 — movida a es-ri (La Rioja)",
		);
		expect(head).toContain(
			"Source-Date: 2026-04-29\nNorm-Id: BOE-A-2026-10117",
		);
		expect(head).not.toContain("Source-Id:");
		expect(git("show", "-M", "--name-status", "--format=", "HEAD")).toMatch(
			/^R\d+\tes\/BOE-A-2026-10117\.md\tes-ri\/BOE-A-2026-10117\.md$/,
		);
		expect(
			git("log", "--follow", "--format=%s", "--", `es-ri/${ID}.md`).split("\n"),
		).toHaveLength(2);

		// The API finds the law at the path it builds from the DB's ELI.
		const api = new GitService(dir);
		expect(await api.getFileAtDate(`es-ri/${ID}.md`, "2026-05-01")).toBe(
			readFileSync(join(dir, `es-ri/${ID}.md`), "utf-8"),
		);

		const again = scanRepo(dir, one(DB_ROW), one(CACHE));
		expect(again.misplaced).toEqual([]);
		expect(again.staleFrontmatter).toEqual([]);
	});

	test("blocked findings are never written", async () => {
		const scan = scanRepo(dir, one(DB_ROW), none);
		expect(scan.misplaced[0]?.status).toBe("blocked");
		expect(
			(await applyMoves(dir, scan.misplaced, none, "2026-09-23", NOW)).moved,
		).toEqual([]);
		expect(existsSync(join(dir, `es/${ID}.md`))).toBe(true);
		expect(git("log", "--format=%s").split("\n")).toHaveLength(1);
	});

	test("reports duplicates and stale frontmatter", () => {
		mkdirSync(join(dir, "es-ri"), { recursive: true });
		writeFileSync(join(dir, `es-ri/${ID}.md`), FILE);
		const scan = scanRepo(dir, one(DB_ROW), one(CACHE));
		expect(scan.duplicates).toEqual([{ id: ID, folders: ["es", "es-ri"] }]);
		expect(scan.misplaced[0]?.reason).toMatch(/varias carpetas/);
		// es-ri/ copy is in the right folder but says jurisdiccion: es.
		expect(scan.staleFrontmatter).toEqual([
			{ relPath: `es-ri/${ID}.md`, jurisdiccion: "es" },
		]);
	});
});
