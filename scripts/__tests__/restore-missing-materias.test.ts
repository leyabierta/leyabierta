import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Norm,
	NormAnalisis,
	NormMetadata,
} from "../../packages/pipeline/src/models.ts";
import { commitNorm } from "../../packages/pipeline/src/pipeline.ts";
import { readAnalisisFromMarkdown } from "../../packages/pipeline/src/transform/analisis.ts";
import { renderNormAtDate } from "../../packages/pipeline/src/transform/markdown.ts";
import {
	extractReforms,
	parseTextXml,
} from "../../packages/pipeline/src/transform/xml-parser.ts";
import {
	applyPlans,
	type CacheEntry,
	cacheEntryFromJson,
	commitDateFor,
	planFile,
	planRepo,
} from "../ad-hoc/restore-missing-materias.ts";

const META: NormMetadata = {
	title: "Constitución Española",
	shortTitle: "CE",
	id: "BOE-A-1978-31229",
	country: "es",
	rank: "constitucion",
	publishedAt: "1978-12-29",
	status: "vigente",
	department: "Cortes Generales",
	source: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
};
const REL = "es/BOE-A-1978-31229.md";

const ANALISIS: NormAnalisis = {
	materias: ["Derecho constitucional", "Derechos fundamentales"],
	notas: ["Nota: 'con comillas' y dos puntos"],
	referencias: {
		anteriores: [],
		posteriores: [
			{
				normId: "BOE-A-1985-12666",
				relation: "SE DESARROLLA",
				text: "Ley Orgánica 6/1985: del Poder Judicial",
			},
		],
	},
};

const XML = join(
	import.meta.dir,
	"../../packages/pipeline/tests/fixtures/constitucion-sample.xml",
);
const loadNorm = async (): Promise<Norm> => {
	const blocks = parseTextXml(await Bun.file(XML).bytes());
	return { metadata: META, blocks, reforms: extractReforms(blocks) };
};
const render = (norm: Norm, analisis?: NormAnalisis) =>
	renderNormAtDate(
		norm.metadata,
		norm.blocks,
		"2024-02-17",
		norm.reforms,
		analisis,
	);
const cache = (analisis?: NormAnalisis): CacheEntry => ({
	relPath: REL,
	analisis,
});
const bodyOf = (md: string) => md.slice(md.indexOf("\n---", 4) + 4);
const git = (repo: string, args: string[]) => {
	const env = { ...process.env } as Record<string, string>;
	for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
	return Bun.spawnSync(["git", ...args], { cwd: repo, env }).stdout.toString();
};

describe("planFile", () => {
	test("a file without análisis becomes exactly what the pipeline renders with it", async () => {
		const norm = await loadNorm();
		const plan = planFile(REL, render(norm), cache(ANALISIS));
		expect(plan.skip).toBeUndefined();
		expect(plan.added).toEqual([
			"materias",
			"notas",
			"referencias_posteriores",
		]);
		expect(plan.content).toBe(render(norm, ANALISIS));
	});

	test("the body is kept byte for byte, even if it drifted from a fresh render", async () => {
		const norm = await loadNorm();
		const md = `${render(norm)}Texto añadido a mano.\n\n---\n\nmaterias: falsa\n`;
		const plan = planFile(REL, md, cache(ANALISIS));
		expect(bodyOf(plan.content!)).toBe(bodyOf(md));
		// Frontmatter only grows: the old one is a prefix of the new one.
		const fm = (s: string) => s.slice(0, s.indexOf("\n---", 4));
		expect(fm(plan.content!).startsWith(fm(md))).toBe(true);
	});

	test("existing análisis keys are never modified or removed", async () => {
		const norm = await loadNorm();
		const mine: NormAnalisis = {
			materias: ["Materia del fichero"],
			notas: [],
			referencias: { anteriores: [], posteriores: [] },
		};
		const plan = planFile(REL, render(norm, mine), cache(ANALISIS));
		expect(plan.added).toEqual(["notas", "referencias_posteriores"]);
		const got = readAnalisisFromMarkdown(plan.content);
		expect(got?.materias).toEqual(["Materia del fichero"]);
		expect(got?.notas).toEqual(ANALISIS.notas);
	});

	test("complete files are left alone (idempotent)", async () => {
		const norm = await loadNorm();
		const plan = planFile(REL, render(norm, ANALISIS), cache(ANALISIS));
		expect(plan.added).toEqual([]);
		expect(plan.content).toBeUndefined();
	});

	test("skip reasons", async () => {
		const norm = await loadNorm();
		const md = render(norm);
		expect(planFile(REL, "sin frontmatter", cache(ANALISIS)).skip).toBe(
			"sin frontmatter",
		);
		expect(planFile(REL, md, undefined).skip).toBe("sin caché JSON");
		expect(planFile(REL, md, cache()).skip).toBe("sin análisis en caché");
		expect(
			planFile(REL, md, {
				relPath: "es-ct/BOE-A-1978-31229.md",
				analisis: ANALISIS,
			}).skip,
		).toBe("caché en otra jurisdicción");
		expect(
			planFile("es/BOE-A-1999-1.md", md, {
				relPath: "es/BOE-A-1999-1.md",
				analisis: ANALISIS,
			}).skip,
		).toBe("identificador distinto del fichero");
		// Hand-formatted YAML that yaml.dump would not reproduce.
		const odd = md.replace("pais: es", "pais:   es");
		expect(planFile(REL, odd, cache(ANALISIS)).skip).toBe(
			"frontmatter no reproducible",
		);
	});
});

test("cacheEntryFromJson places the law by the pipeline's own rule", () => {
	const entry = cacheEntryFromJson({
		metadata: {
			id: "BOE-A-2026-10117",
			country: "es-ri",
			source: "https://www.boe.es/eli/es-ri/l/2026/04/28/2",
		},
		analisis: ANALISIS,
	});
	expect(entry?.relPath).toBe("es-ri/BOE-A-2026-10117.md");
	expect(entry?.analisis).toEqual(ANALISIS);
});

test("commitDateFor: today, unless the content is dated later", () => {
	const p = { id: "x", relPath: "es/x.md", added: [] };
	expect(commitDateFor({ ...p, lastUpdated: "2024-02-17" }, "2026-09-23")).toBe(
		"2026-09-23",
	);
	expect(commitDateFor({ ...p, lastUpdated: "2929-11-19" }, "2026-09-23")).toBe(
		"2929-11-19",
	);
	expect(commitDateFor({ ...p, lastUpdated: undefined }, "2026-09-23")).toBe(
		"2026-09-23",
	);
});

describe("applyPlans on a real repo", () => {
	test("restores análisis in one commit, text untouched, second run is a no-op", async () => {
		const norm = await loadNorm();
		const repo = join(mkdtempSync(join(tmpdir(), "restore-mat-")), "repo");
		await commitNorm(norm, { repoPath: repo, dataDir: `${repo}d` });
		const before = readFileSync(join(repo, REL), "utf-8");
		expect(before).not.toContain("materias:");
		const headBefore = git(repo, ["rev-parse", "HEAD"]).trim();

		const load = (id: string) => (id === META.id ? cache(ANALISIS) : undefined);
		const result = await applyPlans(repo, planRepo(repo, load), "2026-09-23");
		expect(result.written).toBe(1);
		expect(result.commits.length).toBe(1);

		const after = readFileSync(join(repo, REL), "utf-8");
		expect(bodyOf(after)).toBe(bodyOf(before));
		expect(readAnalisisFromMarkdown(after)).toEqual(ANALISIS);

		const log = git(repo, ["log", "-1", "--format=%B%n%an <%ae> %as"]);
		expect(log).toContain("Source-Date: 2026-09-23");
		expect(log).not.toContain("Source-Id:");
		expect(log).toContain("Ley Abierta <bot@leyabierta.es> 2026-09-23");
		expect(git(repo, ["rev-parse", "HEAD~1"]).trim()).toBe(headBefore);

		// Idempotent: nothing left to add.
		const again = await applyPlans(repo, planRepo(repo, load), "2026-09-24");
		expect(again.written).toBe(0);
		expect(again.commits.length).toBe(0);
	});
});
