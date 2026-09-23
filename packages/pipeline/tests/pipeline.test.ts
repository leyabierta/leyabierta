import { beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let gitSeq = 0;

/**
 * Helper to run git commands and capture output reliably.
 * Bun.spawn pipe capture returns empty in bun test runner,
 * so we use execSync with shell-level file redirection.
 */
/** Strip parent git env vars so child git reads the target repo, not a worktree. */
const GIT_LEAK_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
];
function cleanEnv(): Record<string, string> {
	const env = { ...process.env } as Record<string, string>;
	for (const key of GIT_LEAK_VARS) delete env[key];
	return env;
}

function gitOutput(args: string[], cwd: string): string {
	const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
	const outFile = join(tmpdir(), `.git-test-out-${process.pid}-${++gitSeq}`);
	try {
		execSync(`git ${quoted} > '${outFile}' 2>/dev/null`, {
			cwd,
			shell: "/bin/bash",
			env: cleanEnv(),
		});
		return existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";
	} catch {
		return existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";
	} finally {
		try {
			unlinkSync(outFile);
		} catch {}
	}
}

import type { NormMetadata } from "../src/models.ts";
import {
	bootstrapFromLocalXml,
	commitNorm,
	resolveRenderDate,
} from "../src/pipeline.ts";
import { renderNormAtDate } from "../src/transform/markdown.ts";
import { extractReforms, parseTextXml } from "../src/transform/xml-parser.ts";

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
	return mkdtempSync(join(tmpdir(), "leyabierta-test-"));
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

		const mdPath = join(tmpDir, "repo", "es", "BOE-A-1978-31229.md");
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

		const output = gitOutput(["log", "--format=%ai", "--reverse"], repoPath);
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

		const body = gitOutput(["log", "--format=%B", "-1"], repoPath);
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

describe("resolveRenderDate", () => {
	const md = (date: string) =>
		`---\ntitulo: X\nultima_actualizacion: "${date}"\n---\n\n# X\n`;

	test("uses the reform date when the file does not exist yet", () => {
		expect(resolveRenderDate("2023-03-01", undefined)).toBe("2023-03-01");
	});

	test("uses the reform date when it is newer than the file", () => {
		expect(resolveRenderDate("2025-12-04", md("2023-03-01"))).toBe(
			"2025-12-04",
		);
	});

	// Estatuto de los Trabajadores: a 2023 reform arriving after the 2025 ones.
	test("never renders a late-arriving older reform backwards", () => {
		expect(resolveRenderDate("2023-03-01", md("2025-12-04"))).toBe(
			"2025-12-04",
		);
	});

	test("ignores an implausible date already on disk", () => {
		expect(resolveRenderDate("2021-02-24", md("2929-11-19"))).toBe(
			"2021-02-24",
		);
	});

	test("falls back to the reform date when the frontmatter never closes", () => {
		const unclosed =
			'---\ntitulo: X\n\n# X\n\nultima_actualizacion: "2025-01-01"\n';
		expect(resolveRenderDate("2020-01-01", unclosed)).toBe("2020-01-01");
	});

	test("reads the date only from the frontmatter", () => {
		const body = "---\ntitulo: X\n---\n\nultima_actualizacion: 2099-01-01\n";
		expect(resolveRenderDate("2020-01-01", body)).toBe("2020-01-01");
	});
});

describe("commitNorm with a late-arriving reform", () => {
	test("keeps the file at its latest version", async () => {
		const tmpDir = makeTmpDir();
		const config = {
			repoPath: join(tmpDir, "repo"),
			dataDir: join(tmpDir, "data"),
		};
		const blocks = parseTextXml(
			await Bun.file(join(FIXTURES_DIR, "constitucion-sample.xml")).bytes(),
		);
		const reforms = extractReforms(blocks);
		expect(reforms.map((r) => r.date)).toEqual([
			"1978-12-29",
			"1992-08-28",
			"2011-09-27",
			"2024-02-17",
		]);

		// First run: the BOE hasn't published the 2011 reform yet.
		const withoutLate = reforms.filter((r) => r.date !== "2011-09-27");
		await commitNorm(
			{ metadata: CONSTITUCION_METADATA, blocks, reforms: withoutLate },
			config,
		);
		// Second run: it shows up, older than the 2024 one already committed.
		const created = await commitNorm(
			{ metadata: CONSTITUCION_METADATA, blocks, reforms },
			config,
		);
		expect(created).toBe(1);

		const onDisk = readFileSync(
			join(config.repoPath, "es", "BOE-A-1978-31229.md"),
			"utf-8",
		);
		expect(onDisk).toContain('ultima_actualizacion: "2024-02-17"');
		expect(onDisk).toContain('fecha: "2011-09-27"');
		expect(onDisk).toBe(
			renderNormAtDate(CONSTITUCION_METADATA, blocks, "2024-02-17", reforms),
		);
	});
});
