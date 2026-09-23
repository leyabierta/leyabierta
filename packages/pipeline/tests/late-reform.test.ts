/**
 * Late-arriving reforms (A5), through BOTH commit paths. Production (daily
 * `bootstrap` and `rebuild`) goes through commitNormsChronologically, not
 * commitNorm, so the regression must be pinned there too. Unlike the test in
 * pipeline.test.ts, the first run here really lacks the late version in its
 * blocks, so we also check that the late text is added, not just that the
 * newer text survives.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block, Norm, NormMetadata } from "../src/models.ts";
import { commitNorm, commitNormsChronologically } from "../src/pipeline.ts";
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
const tmp = () => mkdtempSync(join(tmpdir(), "adv-"));
const load = async () =>
	parseTextXml(
		await Bun.file(
			join(import.meta.dir, "fixtures", "constitucion-sample.xml"),
		).bytes(),
	);
const dropVersion = (blocks: readonly Block[], normId: string): Block[] =>
	blocks.map((b) => ({
		...b,
		versions: b.versions.filter((v) => v.normId !== normId),
	}));
const redate = (
	blocks: readonly Block[],
	normId: string,
	date: string,
): Block[] =>
	blocks.map((b) => ({
		...b,
		versions: b.versions.map((v) =>
			v.normId === normId ? { ...v, publishedAt: date, effectiveAt: date } : v,
		),
	}));
const read = (repo: string) =>
	readFileSync(join(repo, "es", "BOE-A-1978-31229.md"), "utf-8");
function git(repo: string, args: string[]): string {
	const env = { ...process.env } as Record<string, string>;
	for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
	const r = Bun.spawnSync(["git", ...args], { cwd: repo, env });
	return r.stdout.toString();
}

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

describe("late-arriving reforms", () => {
	for (const [name, fn] of runners) {
		test(`${name}: late version text is added, later text kept`, async () => {
			const full = await load();
			const repo = join(tmp(), "repo");
			const b1 = dropVersion(full, "BOE-A-2011-15210");
			await fn(
				{ metadata: META, blocks: b1, reforms: extractReforms(b1) },
				repo,
			);
			expect(read(repo)).not.toContain("estabilidad presupuestaria");
			await fn(
				{ metadata: META, blocks: full, reforms: extractReforms(full) },
				repo,
			);
			const md = read(repo);
			expect(md).toContain("estabilidad presupuestaria");
			expect(md).toContain('ultima_actualizacion: "2024-02-17"');
			expect(md).toContain('fecha: "2011-09-27"');
		});
		test(`${name}: 2929 version does not freeze later renders`, async () => {
			const full = await load();
			const repo = join(tmp(), "repo");
			const b1 = redate(
				dropVersion(full, "BOE-A-2011-15210"),
				"BOE-A-2024-3099",
				"2929-11-19",
			);
			await fn(
				{ metadata: META, blocks: b1, reforms: extractReforms(b1) },
				repo,
			);
			expect(read(repo)).toContain('ultima_actualizacion: "2929-11-19"');
			const b2 = redate(full, "BOE-A-2024-3099", "2929-11-19");
			await fn(
				{ metadata: META, blocks: b2, reforms: extractReforms(b2) },
				repo,
			);
			const md = read(repo);
			expect(md).toContain('ultima_actualizacion: "2011-09-27"');
			expect(md).toContain("estabilidad presupuestaria");
		});
		test(`${name}: fresh repo history unchanged`, async () => {
			const full = await load();
			const repo = join(tmp(), "repo");
			await fn(
				{ metadata: META, blocks: full, reforms: extractReforms(full) },
				repo,
			);
			const shas = git(repo, ["log", "--format=%H", "--reverse"])
				.trim()
				.split("\n");
			const dates = shas.map(
				(s) =>
					git(repo, ["show", `${s}:es/BOE-A-1978-31229.md`]).match(
						/ultima_actualizacion: "([^"]+)"/,
					)?.[1],
			);
			expect(dates).toEqual([
				"1978-12-29",
				"1992-08-28",
				"2011-09-27",
				"2024-02-17",
			]);
		});
	}
});
