/**
 * Análisis (materias, notas, referencias) must survive the daily run.
 *
 * Before the fix, `fetchNorm` never loaded análisis: every daily `bootstrap`
 * commit rewrote the file in `leyes` without `materias` / `notas` /
 * `referencias_*`, and overwrote the JSON cache without `analisis` until
 * Step 3 (`ingest-analisis`) put it back. These tests pin the three layers of
 * the fix: fetchNorm keeps the cached análisis (and asks the source only when
 * there is none), and both commit paths keep the file's own análisis when the
 * norm has none.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	LegislativeClient,
	MetadataParser,
	TextParser,
} from "../src/country.ts";
import type { Norm, NormAnalisis, NormMetadata } from "../src/models.ts";
import {
	commitNorm,
	commitNormsChronologically,
	fetchNorm,
	resolveAnalisis,
} from "../src/pipeline.ts";
import { BoeClient } from "../src/spain/boe-client.ts";
import { resolveMaterias } from "../src/spain/materias.ts";
import {
	canonicalRefs,
	parseCachedAnalisis,
	readAnalisisFromMarkdown,
} from "../src/transform/analisis.ts";
import { renderNormAtDate } from "../src/transform/markdown.ts";
import { extractReforms, parseTextXml } from "../src/transform/xml-parser.ts";

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

const ANALISIS: NormAnalisis = {
	materias: ["Derecho constitucional", "Derechos fundamentales"],
	notas: ["Entrada en vigor el 29 de diciembre de 1978."],
	referencias: {
		anteriores: [
			{ normId: "BOE-A-1977-6666", relation: "DEROGA", text: "Ley: 1/1977" },
		],
		posteriores: [
			{
				normId: "BOE-A-1985-12666",
				relation: "SE DESARROLLA",
				text: "Ley Orgánica del Poder Judicial",
			},
		],
	},
};

const XML = join(import.meta.dir, "fixtures", "constitucion-sample.xml");
const tmp = () => mkdtempSync(join(tmpdir(), "analisis-"));
const loadBlocks = async () => parseTextXml(await Bun.file(XML).bytes());
const read = (repo: string) =>
	readFileSync(join(repo, "es", "BOE-A-1978-31229.md"), "utf-8");

describe("transform/analisis", () => {
	test("frontmatter round trip: render → read gives the same análisis", async () => {
		const blocks = await loadBlocks();
		const md = renderNormAtDate(
			META,
			blocks,
			"2024-02-17",
			extractReforms(blocks),
			ANALISIS,
		);
		expect(md).toContain("materias:\n  - Derecho constitucional");
		expect(readAnalisisFromMarkdown(md)).toEqual(ANALISIS);
	});

	test("files without análisis read as undefined", async () => {
		const blocks = await loadBlocks();
		const md = renderNormAtDate(META, blocks, "2024-02-17", []);
		expect(readAnalisisFromMarkdown(md)).toBeUndefined();
		expect(readAnalisisFromMarkdown(undefined)).toBeUndefined();
		expect(readAnalisisFromMarkdown("no frontmatter")).toBeUndefined();
	});

	test("a legal text quoting `materias:` in the body is not read as análisis", () => {
		const md = "---\ntitulo: X\n---\n\nmaterias:\n  - Inventada\n";
		expect(readAnalisisFromMarkdown(md)).toBeUndefined();
	});

	test("JSON cache: parsed when present, undefined when absent or empty", () => {
		expect(parseCachedAnalisis({ analisis: ANALISIS })).toEqual(ANALISIS);
		expect(parseCachedAnalisis({ metadata: {} })).toBeUndefined();
		expect(
			parseCachedAnalisis({
				analisis: {
					materias: [],
					notas: [],
					referencias: { anteriores: [], posteriores: [] },
				},
			}),
		).toBeUndefined();
	});

	test("resolveMaterias never fabricates names", () => {
		const missing = new Set<string>();
		expect(
			resolveMaterias(["1", "2"], { "1": "Empleo" }, ["Parcial"], missing),
		).toEqual(["Empleo"]);
		expect([...missing]).toEqual(["2"]);
		expect(resolveMaterias(["9"], {}, ["Parcial"])).toEqual(["Parcial"]);
	});

	test("canonicalRefs: DB shape — no empty target, one per (target, relation), sorted", () => {
		expect(
			canonicalRefs([
				{ normId: "BOE-B-1958-7949", relation: "DEROGA", text: "b" },
				{ normId: "", relation: "CITA", text: "sin destino" },
				{ normId: "BOE-A-1977-165", relation: "SE MODIFICA", text: "old" },
				{ normId: "BOE-A-1977-165", relation: "DEROGA", text: "a" },
				{ normId: "BOE-A-1977-165", relation: "SE MODIFICA", text: "new" },
			]),
		).toEqual([
			{ normId: "BOE-A-1977-165", relation: "DEROGA", text: "a" },
			{ normId: "BOE-A-1977-165", relation: "SE MODIFICA", text: "new" },
			{ normId: "BOE-B-1958-7949", relation: "DEROGA", text: "b" },
		]);
	});

	test("BoeClient.getNormAnalisis matches the Step-3 cache shape (no reorder churn)", async () => {
		// A new law's first commit uses the BOE; its next one uses the cache
		// Step 3 wrote from the DB. Both must render the same frontmatter.
		const client = new BoeClient(0, "/nonexistent/materias.json");
		client.getAnalisis = async () => ({
			materias: ["Zeta", "Alfa", "Alfa"],
			notas: ["Nota 1"],
			referencias: {
				anteriores: [
					{ normId: "BOE-A-2000-2", relation: "DEROGA", text: "dos" },
					{ normId: "BOE-A-2000-1", relation: "DEROGA", text: "uno" },
				],
				posteriores: [
					{ normId: "", relation: "CITA", text: "x" },
					{ normId: "BOE-A-2020-9", relation: "SE MODIFICA", text: "m" },
				],
			},
		});
		client.getMateriaCodes = async () => [];
		const fresh = await client.getNormAnalisis("BOE-A-1999-1");
		const cache = parseCachedAnalisis({
			analisis: {
				materias: ["Alfa", "Zeta"],
				notas: ["Nota 1"],
				referencias: {
					anteriores: [
						{ normId: "BOE-A-2000-1", relation: "DEROGA", text: "uno" },
						{ normId: "BOE-A-2000-2", relation: "DEROGA", text: "dos" },
					],
					posteriores: [
						{ normId: "BOE-A-2020-9", relation: "SE MODIFICA", text: "m" },
					],
				},
			},
		});
		expect(fresh).toEqual(cache);
	});

	test("resolveAnalisis: the norm's análisis wins, else the file's", async () => {
		const blocks = await loadBlocks();
		const withAna = renderNormAtDate(META, blocks, "2024-02-17", [], ANALISIS);
		const other = { ...ANALISIS, materias: ["Otra"] };
		expect(resolveAnalisis({ analisis: other }, withAna)).toEqual(other);
		expect(resolveAnalisis({}, withAna)).toEqual(ANALISIS);
		expect(resolveAnalisis({}, undefined)).toBeUndefined();
	});
});

const runners = [
	[
		"commitNorm",
		(n: Norm, r: string) => commitNorm(n, { repoPath: r, dataDir: `${r}d` }),
	],
	[
		"chrono",
		(n: Norm, r: string) =>
			commitNormsChronologically([n], { repoPath: r, dataDir: `${r}d` }),
	],
] as const;

describe("commit paths keep análisis", () => {
	for (const [name, fn] of runners) {
		test(`${name}: a reform without análisis keeps the file's materias`, async () => {
			const full = await loadBlocks();
			const repo = join(tmp(), "repo");
			// First run (e.g. `rebuild` from the enriched cache) has análisis,
			// but not the last reform.
			const older = full.map((b) => ({
				...b,
				versions: b.versions.filter((v) => v.normId !== "BOE-A-2024-3099"),
			}));
			await fn(
				{
					metadata: META,
					blocks: older,
					reforms: extractReforms(older),
					analisis: ANALISIS,
				},
				repo,
			);
			expect(read(repo)).toContain("materias:");
			// Daily run: the new reform arrives with no análisis on the norm.
			await fn(
				{ metadata: META, blocks: full, reforms: extractReforms(full) },
				repo,
			);
			const md = read(repo);
			expect(md).toContain('ultima_actualizacion: "2024-02-17"');
			expect(readAnalisisFromMarkdown(md)).toEqual(ANALISIS);
		});

		test(`${name}: the norm's análisis is written on a file that had none`, async () => {
			const full = await loadBlocks();
			const repo = join(tmp(), "repo");
			const older = full.map((b) => ({
				...b,
				versions: b.versions.filter((v) => v.normId !== "BOE-A-2024-3099"),
			}));
			await fn(
				{ metadata: META, blocks: older, reforms: extractReforms(older) },
				repo,
			);
			expect(read(repo)).not.toContain("materias:");
			await fn(
				{
					metadata: META,
					blocks: full,
					reforms: extractReforms(full),
					analisis: ANALISIS,
				},
				repo,
			);
			expect(readAnalisisFromMarkdown(read(repo))).toEqual(ANALISIS);
		});
	}
});

// ─── fetchNorm ───

const textParser: TextParser = {
	parseText: parseTextXml,
	extractReforms,
};
const metadataParser: MetadataParser = { parse: () => META };

function fakeClient(
	getNormAnalisis?: () => Promise<NormAnalisis | undefined>,
): LegislativeClient & { analisisCalls: number } {
	const client = {
		analisisCalls: 0,
		getText: async () => Bun.file(XML).bytes(),
		getMetadata: async () => new Uint8Array(),
		close: async () => {},
	} as LegislativeClient & { analisisCalls: number };
	if (getNormAnalisis) {
		client.getNormAnalisis = async () => {
			client.analisisCalls++;
			return getNormAnalisis();
		};
	}
	return client;
}

function seedCache(dataDir: string, analisis?: NormAnalisis): string {
	mkdirSync(join(dataDir, "json"), { recursive: true });
	const path = join(dataDir, "json", `${META.id}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			metadata: { id: META.id },
			articles: [],
			reforms: [],
			...(analisis ? { analisis } : {}),
		}),
	);
	return path;
}

describe("fetchNorm keeps análisis", () => {
	test("carries the cached análisis over and keeps it in the rewritten cache", async () => {
		const dataDir = tmp();
		const path = seedCache(dataDir, ANALISIS);
		const client = fakeClient(async () => ({ ...ANALISIS, materias: ["BOE"] }));
		const norm = await fetchNorm(
			META.id,
			client,
			textParser,
			metadataParser,
			dataDir,
		);
		expect(norm?.analisis).toEqual(ANALISIS);
		// The cache wins: no extra BOE requests for a norm Step 3 already covers.
		expect(client.analisisCalls).toBe(0);
		const cached = JSON.parse(readFileSync(path, "utf-8"));
		expect(parseCachedAnalisis(cached)).toEqual(ANALISIS);
		expect(cached.articles.length).toBeGreaterThan(0);
	});

	test("asks the source when the cache has no análisis (new norm)", async () => {
		const dataDir = tmp();
		const client = fakeClient(async () => ANALISIS);
		const norm = await fetchNorm(
			META.id,
			client,
			textParser,
			metadataParser,
			dataDir,
		);
		expect(client.analisisCalls).toBe(1);
		expect(norm?.analisis).toEqual(ANALISIS);
	});

	test("a failing análisis fetch never fails the norm", async () => {
		const dataDir = tmp();
		seedCache(dataDir);
		const client = fakeClient(async () => {
			throw new Error("BOE 503");
		});
		const norm = await fetchNorm(
			META.id,
			client,
			textParser,
			metadataParser,
			dataDir,
		);
		expect(norm).not.toBeNull();
		expect(norm?.analisis).toBeUndefined();
	});

	test("clients without getNormAnalisis still work", async () => {
		const norm = await fetchNorm(
			META.id,
			fakeClient(),
			textParser,
			metadataParser,
			tmp(),
		);
		expect(norm?.analisis).toBeUndefined();
		expect(norm?.blocks.length).toBeGreaterThan(0);
	});
});
