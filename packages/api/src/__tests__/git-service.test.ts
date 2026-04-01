/**
 * Unit tests for GitService.
 *
 * Creates real git repos in temp directories for integration-style tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../services/git.ts";

let tempDir: string;

async function git(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.dev",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.dev",
		},
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

async function initRepo(): Promise<string> {
	const dir = join(
		tmpdir(),
		`git-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	await git(["init"], dir);
	await git(["config", "user.name", "Test"], dir);
	await git(["config", "user.email", "test@test.dev"], dir);
	return dir;
}

beforeEach(async () => {
	tempDir = await initRepo();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("GitService", () => {
	describe("getFileAtDate", () => {
		test("returns content of a file at a specific date", async () => {
			// Create a file and commit it with a specific date
			const filePath = "es/law.md";
			mkdirSync(join(tempDir, "es"), { recursive: true });
			writeFileSync(join(tempDir, filePath), "Version 1");
			await git(["add", "."], tempDir);
			await git(
				["-c", "commit.gpgsign=false", "commit", "-m", "first"],
				tempDir,
			);

			const svc = new GitService(tempDir);
			const content = await svc.getFileAtDate(filePath, "2099-12-31");
			expect(content).toContain("Version 1");
		});

		test("returns null for non-existent file", async () => {
			// Need at least one commit for the repo to have HEAD
			writeFileSync(join(tempDir, "dummy.txt"), "x");
			await git(["add", "."], tempDir);
			await git(
				["-c", "commit.gpgsign=false", "commit", "-m", "init"],
				tempDir,
			);

			const svc = new GitService(tempDir);
			const content = await svc.getFileAtDate("nonexistent.md", "2099-12-31");
			expect(content).toBeNull();
		});
	});

	describe("diff", () => {
		test("returns null for dates with no commits", async () => {
			writeFileSync(join(tempDir, "dummy.txt"), "x");
			await git(["add", "."], tempDir);
			await git(
				["-c", "commit.gpgsign=false", "commit", "-m", "init"],
				tempDir,
			);

			const svc = new GitService(tempDir);
			// Use dates far in the past where no commits exist
			const result = await svc.diff("dummy.txt", "1900-01-01", "1900-01-02");
			expect(result).toBeNull();
		});

		test("returns empty string when both dates resolve to same commit", async () => {
			writeFileSync(join(tempDir, "law.md"), "content");
			await git(["add", "."], tempDir);
			await git(["-c", "commit.gpgsign=false", "commit", "-m", "v1"], tempDir);

			const svc = new GitService(tempDir);
			const result = await svc.diff("law.md", "2099-01-01", "2099-12-31");
			expect(result).toBe("");
		});
	});

	describe("constructor", () => {
		test("handles non-existent repo path gracefully", async () => {
			const badPath = join(tmpdir(), `nonexistent-repo-${Date.now()}`);
			const svc = new GitService(badPath);
			// Operations should return null / empty, not throw
			const content = await svc.getFileAtDate("any.md", "2024-01-01");
			expect(content).toBeNull();
		});
	});

	describe("log", () => {
		test("returns empty array for non-existent file", async () => {
			writeFileSync(join(tempDir, "dummy.txt"), "x");
			await git(["add", "."], tempDir);
			await git(
				["-c", "commit.gpgsign=false", "commit", "-m", "init"],
				tempDir,
			);

			const svc = new GitService(tempDir);
			const entries = await svc.log("nonexistent.md");
			expect(entries).toEqual([]);
		});
	});
});
