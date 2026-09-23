/**
 * GitRepo.moveNorm — move a norm between jurisdiction folders in ONE commit,
 * so the one-norm-one-folder invariant holds at every commit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepo } from "../src/git/repo.ts";
import type { CommitInfo } from "../src/models.ts";
import { assertUniqueByNormId } from "../src/pipeline.ts";

let dir: string;
let repo: GitRepo;

const git = (...args: string[]) =>
	execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();

const BODY = Array.from({ length: 40 }, (_, i) => `Artículo ${i + 1}.`).join(
	"\n",
);

const commitInfo = (subject: string, date: string): CommitInfo => ({
	commitType: "fix-pipeline",
	subject,
	body: "test",
	trailers: { "Norm-Id": "BOE-A-2026-10117" },
	authorName: "Ley Abierta",
	authorEmail: "bot@leyabierta.es",
	authorDate: date,
	filePath: "",
	content: "",
});

beforeEach(async () => {
	dir = join(
		tmpdir(),
		`move-norm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	repo = new GitRepo(dir, "Test", "test@test");
	await repo.init();
	repo.writeAndAdd("es/BOE-A-2026-10117.md", `jurisdiccion: es\n${BODY}\n`);
	await repo.add("es/BOE-A-2026-10117.md");
	await repo.commit(commitInfo("bootstrap", "2026-04-29"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("GitRepo.moveNorm", () => {
	test("stages removal + new path; one commit; invariant holds", async () => {
		await repo.moveNorm(
			"es/BOE-A-2026-10117.md",
			"es-ri/BOE-A-2026-10117.md",
			`jurisdiccion: es-ri\n${BODY}\n`,
		);
		expect(existsSync(join(dir, "es/BOE-A-2026-10117.md"))).toBe(false);
		expect(readFileSync(join(dir, "es-ri/BOE-A-2026-10117.md"), "utf-8")).toBe(
			`jurisdiccion: es-ri\n${BODY}\n`,
		);
		expect(
			git("diff", "--cached", "--no-renames", "--name-status")
				.split("\n")
				.sort(),
		).toEqual(["A\tes-ri/BOE-A-2026-10117.md", "D\tes/BOE-A-2026-10117.md"]);

		await repo.commit(commitInfo("move", "2026-09-23"));
		await assertUniqueByNormId(dir);
		expect(git("status", "--porcelain")).toBe("");
		// The commit touches both paths; git sees a rename.
		expect(git("show", "--name-status", "-M", "--format=", "HEAD")).toMatch(
			/^R\d+\tes\/BOE-A-2026-10117\.md\tes-ri\/BOE-A-2026-10117\.md$/,
		);
		// History continuity: --follow reaches the bootstrap commit.
		expect(
			git("log", "--follow", "--format=%s", "--", "es-ri/BOE-A-2026-10117.md"),
		).toBe("move\nbootstrap");
	});

	test("later writes to the new path pass the cross-folder check", async () => {
		await repo.moveNorm(
			"es/BOE-A-2026-10117.md",
			"es-ri/BOE-A-2026-10117.md",
			"v1\n",
		);
		await repo.commit(commitInfo("move", "2026-09-23"));
		expect(repo.writeAndAdd("es-ri/BOE-A-2026-10117.md", "v2\n")).toBe(true);
		// …and writing the old folder again is now the duplicate.
		expect(() => repo.writeAndAdd("es/BOE-A-2026-10117.md", "v2\n")).toThrow(
			/already exists/,
		);
	});

	test("the index is used: a fresh GitRepo sees the moved file", async () => {
		await repo.moveNorm(
			"es/BOE-A-2026-10117.md",
			"es-ri/BOE-A-2026-10117.md",
			"v1\n",
		);
		await repo.commit(commitInfo("move", "2026-09-23"));
		const fresh = new GitRepo(dir, "Test", "test@test");
		expect(() => fresh.writeAndAdd("es/BOE-A-2026-10117.md", "x\n")).toThrow(
			/already exists/,
		);
	});

	test("refuses different ids, same folder, missing source, existing target", async () => {
		await expect(
			repo.moveNorm("es/BOE-A-2026-10117.md", "es-ri/BOE-A-2026-99999.md", "x"),
		).rejects.toThrow(/change the norm id/);
		await expect(
			repo.moveNorm("es/BOE-A-2026-10117.md", "es/BOE-A-2026-10117.md", "x"),
		).rejects.toThrow(/already in es/);
		await expect(
			repo.moveNorm("es/BOE-A-2026-1.md", "es-ri/BOE-A-2026-1.md", "x"),
		).rejects.toThrow(/does not exist/);
		await expect(
			repo.moveNorm("es/README.md", "es-ri/README.md", "x"),
		).rejects.toThrow(/norm paths/);

		// A pre-existing duplicate (written outside GitRepo, like the 2026-04
		// backfill incident): the move must not overwrite the target.
		mkdirSync(join(dir, "es-as"), { recursive: true });
		writeFileSync(join(dir, "es-as/BOE-A-2026-12186.md"), "a\n");
		writeFileSync(join(dir, "es/BOE-A-2026-12186.md"), "b\n");
		await expect(
			repo.moveNorm("es/BOE-A-2026-12186.md", "es-as/BOE-A-2026-12186.md", "x"),
		).rejects.toThrow(/already exists/);

		// Nothing was staged by the refused moves.
		expect(git("diff", "--cached", "--name-only")).toBe("");
		expect(existsSync(join(dir, "es/BOE-A-2026-10117.md"))).toBe(true);
	});
});
