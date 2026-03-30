/**
 * Unit tests for GitRepo.
 *
 * Creates real git repos in temp directories.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepo } from "../src/git/repo.ts";
import type { CommitInfo } from "../src/models.ts";

let tempDir: string;
let repo: GitRepo;

function makeCommitInfo(overrides: Partial<CommitInfo> = {}): CommitInfo {
	return {
		commitType: "bootstrap",
		subject: "[bootstrap] Test Law — original version 2024",
		body: "Original publication of Test Law.",
		trailers: {
			"Source-Id": "BOE-A-2024-1234",
			"Source-Date": "2024-01-15",
			"Norm-Id": "BOE-A-2020-5678",
		},
		authorName: "Ley Abierta",
		authorEmail: "bot@leyabierta.es",
		authorDate: "2024-01-15",
		filePath: "es/test.md",
		content: "# Test Law\n\nArticle 1.",
		...overrides,
	};
}

beforeEach(() => {
	tempDir = join(
		tmpdir(),
		`git-repo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });
	repo = new GitRepo(tempDir, "Test Bot", "test@bot.dev");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("GitRepo", () => {
	describe("init", () => {
		test("creates a git repo", async () => {
			await repo.init();
			expect(existsSync(join(tempDir, ".git"))).toBe(true);
		});

		test("is idempotent (calling init twice does not fail)", async () => {
			await repo.init();
			await repo.init();
			expect(existsSync(join(tempDir, ".git"))).toBe(true);
		});
	});

	describe("writeAndAdd", () => {
		test("returns true for new file", async () => {
			await repo.init();
			const changed = repo.writeAndAdd("es/law.md", "# Law\n\nContent.");
			expect(changed).toBe(true);
			expect(existsSync(join(tempDir, "es/law.md"))).toBe(true);
		});

		test("returns false for identical content", async () => {
			await repo.init();
			repo.writeAndAdd("es/law.md", "# Law\n\nContent.");
			const changed = repo.writeAndAdd("es/law.md", "# Law\n\nContent.");
			expect(changed).toBe(false);
		});

		test("returns true when content differs", async () => {
			await repo.init();
			repo.writeAndAdd("es/law.md", "# Law\n\nVersion 1.");
			const changed = repo.writeAndAdd("es/law.md", "# Law\n\nVersion 2.");
			expect(changed).toBe(true);
		});
	});

	describe("commit", () => {
		test("creates a commit with correct message", async () => {
			await repo.init();
			const info = makeCommitInfo();
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			const sha = await repo.commit(info);

			expect(sha).not.toBeNull();
			expect(sha!.length).toBeGreaterThanOrEqual(7);

			// Verify commit message contains the subject
			const log = await repo.log("%s", false);
			expect(log).toContain("[bootstrap] Test Law");
		});

		test("with allowEmpty=true creates empty commit", async () => {
			await repo.init();
			// Need at least one commit first to have HEAD
			const info1 = makeCommitInfo();
			repo.writeAndAdd(info1.filePath, info1.content);
			await repo.add(info1.filePath);
			await repo.commit(info1);

			// Now create an empty commit
			const info2 = makeCommitInfo({
				subject: "[fix-pipeline] Empty commit",
				trailers: {
					"Source-Id": "BOE-A-2024-9999",
					"Source-Date": "2024-06-01",
					"Norm-Id": "BOE-A-2020-5678",
				},
			});
			const sha = await repo.commit(info2, true);
			expect(sha).not.toBeNull();
		});

		test("returns null when nothing staged and allowEmpty=false", async () => {
			await repo.init();
			// Create an initial commit so the repo is not empty
			const info1 = makeCommitInfo();
			repo.writeAndAdd(info1.filePath, info1.content);
			await repo.add(info1.filePath);
			await repo.commit(info1);

			// Try to commit with nothing staged
			const info2 = makeCommitInfo({ subject: "[reforma] No changes" });
			const sha = await repo.commit(info2, false);
			expect(sha).toBeNull();
		});
	});

	describe("hasCommitWithSourceId", () => {
		test("finds existing commits by Source-Id and Norm-Id", async () => {
			await repo.init();
			const info = makeCommitInfo();
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			await repo.commit(info);

			await repo.loadExistingCommits();
			expect(
				repo.hasCommitWithSourceId("BOE-A-2024-1234", "BOE-A-2020-5678"),
			).toBe(true);
		});

		test("returns false for non-existent Source-Id", async () => {
			await repo.init();
			const info = makeCommitInfo();
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			await repo.commit(info);

			await repo.loadExistingCommits();
			expect(
				repo.hasCommitWithSourceId("BOE-A-9999-9999", "BOE-A-2020-5678"),
			).toBe(false);
		});

		test("finds Source-Id without specifying Norm-Id", async () => {
			await repo.init();
			const info = makeCommitInfo();
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			await repo.commit(info);

			await repo.loadExistingCommits();
			expect(repo.hasCommitWithSourceId("BOE-A-2024-1234")).toBe(true);
			expect(repo.hasCommitWithSourceId("BOE-A-0000-0000")).toBe(false);
		});

		test("throws if loadExistingCommits was not called", () => {
			expect(() => repo.hasCommitWithSourceId("X")).toThrow(
				"Call loadExistingCommits() first",
			);
		});
	});

	describe("loadExistingCommits", () => {
		test("parses Source-Id and Norm-Id trailers from multiple commits", async () => {
			await repo.init();

			const info1 = makeCommitInfo({
				trailers: {
					"Source-Id": "SRC-001",
					"Source-Date": "2024-01-01",
					"Norm-Id": "NORM-A",
				},
			});
			repo.writeAndAdd(info1.filePath, "Version 1");
			await repo.add(info1.filePath);
			await repo.commit(info1);

			const info2 = makeCommitInfo({
				trailers: {
					"Source-Id": "SRC-002",
					"Source-Date": "2024-06-01",
					"Norm-Id": "NORM-B",
				},
				authorDate: "2024-06-01",
			});
			repo.writeAndAdd(info2.filePath, "Version 2");
			await repo.add(info2.filePath);
			await repo.commit(info2);

			await repo.loadExistingCommits();
			expect(repo.hasCommitWithSourceId("SRC-001", "NORM-A")).toBe(true);
			expect(repo.hasCommitWithSourceId("SRC-002", "NORM-B")).toBe(true);
			expect(repo.hasCommitWithSourceId("SRC-003", "NORM-C")).toBe(false);
		});

		test("handles empty repo gracefully", async () => {
			await repo.init();
			await repo.loadExistingCommits();
			expect(repo.hasCommitWithSourceId("anything")).toBe(false);
		});
	});
});
