import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormMetadata } from "../src/models.ts";
import { bootstrapFromLocalXml } from "../src/pipeline.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

const CONSTITUCION_METADATA: NormMetadata = {
	title: "Constitución Española",
	shortTitle: "Constitución Española",
	id: "BOE-A-1978-31229",
	country: "es",
	rank: "constitucion",
	publishedAt: "1978-12-29",
	status: "vigente",
	department: "Cortes Generales",
	source: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
};

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "leylibre-test-"));
}

describe("bootstrapFromLocalXml", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	test("creates 4 commits from Constitution XML", async () => {
		const count = await bootstrapFromLocalXml(
			CONSTITUCION_METADATA,
			join(FIXTURES_DIR, "constitucion-sample.xml"),
			{ repoPath: join(tmpDir, "repo"), dataDir: join(tmpDir, "data") },
		);
		expect(count).toBe(4);
	});

	test("creates markdown file with frontmatter", async () => {
		await bootstrapFromLocalXml(
			CONSTITUCION_METADATA,
			join(FIXTURES_DIR, "constitucion-sample.xml"),
			{ repoPath: join(tmpDir, "repo"), dataDir: join(tmpDir, "data") },
		);

		const mdPath = join(
			tmpDir,
			"repo",
			"es",
			"BOE-A-1978-31229.md",
		);
		const content = await Bun.file(mdPath).text();
		expect(content).toContain("Constitución Española");
		expect(content).toContain("---");
	});

	test("commits have correct historical dates", async () => {
		const repoPath = join(tmpDir, "repo");
		await bootstrapFromLocalXml(
			CONSTITUCION_METADATA,
			join(FIXTURES_DIR, "constitucion-sample.xml"),
			{ repoPath, dataDir: join(tmpDir, "data") },
		);

		const proc = Bun.spawn(["git", "log", "--format=%ai", "--reverse"], {
			cwd: repoPath,
			stdout: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		const dates = output
			.trim()
			.split("\n")
			.map((line) => line.split(" ")[0]);

		expect(dates).toEqual([
			"1978-12-29",
			"1992-08-28",
			"2011-09-27",
			"2024-02-17",
		]);
	});

	test("commits have trailers", async () => {
		const repoPath = join(tmpDir, "repo");
		await bootstrapFromLocalXml(
			CONSTITUCION_METADATA,
			join(FIXTURES_DIR, "constitucion-sample.xml"),
			{ repoPath, dataDir: join(tmpDir, "data") },
		);

		const proc = Bun.spawn(["git", "log", "--format=%B", "-1"], {
			cwd: repoPath,
			stdout: "pipe",
		});
		const body = await new Response(proc.stdout).text();
		expect(body).toContain("Source-Id:");
		expect(body).toContain("Source-Date:");
		expect(body).toContain("Norm-Id: BOE-A-1978-31229");
	});

	test("idempotent — second run creates 0 commits", async () => {
		const config = {
			repoPath: join(tmpDir, "repo"),
			dataDir: join(tmpDir, "data"),
		};
		const xmlPath = join(FIXTURES_DIR, "constitucion-sample.xml");

		const count1 = await bootstrapFromLocalXml(
			CONSTITUCION_METADATA,
			xmlPath,
			config,
		);
		const count2 = await bootstrapFromLocalXml(
			CONSTITUCION_METADATA,
			xmlPath,
			config,
		);

		expect(count1).toBe(4);
		expect(count2).toBe(0);
	});

	test("saves JSON cache", async () => {
		const dataDir = join(tmpDir, "data");
		await bootstrapFromLocalXml(
			CONSTITUCION_METADATA,
			join(FIXTURES_DIR, "constitucion-sample.xml"),
			{ repoPath: join(tmpDir, "repo"), dataDir },
		);

		const jsonPath = join(dataDir, "json", "BOE-A-1978-31229.json");
		const exists = await Bun.file(jsonPath).exists();
		expect(exists).toBe(true);
	});
});
