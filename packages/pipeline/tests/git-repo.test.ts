/**
 * Unit tests for GitRepo.
 *
 * Creates real git repos in temp directories.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
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
				await repo.hasCommitWithSourceId("BOE-A-2024-1234", "BOE-A-2020-5678"),
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
				await repo.hasCommitWithSourceId("BOE-A-9999-9999", "BOE-A-2020-5678"),
			).toBe(false);
		});

		test("finds Source-Id without specifying Norm-Id", async () => {
			await repo.init();
			const info = makeCommitInfo();
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			await repo.commit(info);

			await repo.loadExistingCommits();
			expect(await repo.hasCommitWithSourceId("BOE-A-2024-1234")).toBe(true);
			expect(await repo.hasCommitWithSourceId("BOE-A-0000-0000")).toBe(false);
		});

		test("works without calling loadExistingCommits first (git-grep fallback)", async () => {
			await repo.init();
			const info = makeCommitInfo();
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			await repo.commit(info);

			// No loadExistingCommits() call — must still work via git log --grep
			expect(
				await repo.hasCommitWithSourceId("BOE-A-2024-1234", "BOE-A-2020-5678"),
			).toBe(true);
			expect(
				await repo.hasCommitWithSourceId("BOE-A-9999-9999", "BOE-A-2020-5678"),
			).toBe(false);
		});

		// ── Test 3: dedupe by Source-Id (required by idempotency spec) ─────────
		test("deduplication: detects existing Source-Id in repo with a commit containing it", async () => {
			await repo.init();
			const info = makeCommitInfo({
				trailers: {
					"Source-Id": "BOE-A-2014-2997",
					"Source-Date": "2014-03-21",
					"Norm-Id": "BOE-A-2014-2997",
				},
			});
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			await repo.commit(info);

			// Should find the commit by its Source-Id trailer
			expect(await repo.hasCommitWithSourceId("BOE-A-2014-2997")).toBe(true);
			// Should not find an id that was never committed
			expect(await repo.hasCommitWithSourceId("BOE-A-2014-9999")).toBe(false);
		});

		test("Norm-Id check rejects prefix collisions (BOE-A-2025-76 vs BOE-A-2025-7659)", async () => {
			// Regression for a real risk: includes("Norm-Id: BOE-A-2025-76")
			// would match a body containing "Norm-Id: BOE-A-2025-7659".
			// We commit the longer id, then ask for the shorter one with the
			// same Source-Id — must return false.
			await repo.init();
			const info = makeCommitInfo({
				trailers: {
					"Source-Id": "BOE-A-2026-9999",
					"Source-Date": "2026-04-30",
					"Norm-Id": "BOE-A-2025-7659",
				},
			});
			repo.writeAndAdd(info.filePath, info.content);
			await repo.add(info.filePath);
			await repo.commit(info);

			// Source-Id matches and Norm-Id is the long form: hit
			expect(
				await repo.hasCommitWithSourceId("BOE-A-2026-9999", "BOE-A-2025-7659"),
			).toBe(true);
			// Same Source-Id but Norm-Id is a strict prefix: must NOT collide
			expect(
				await repo.hasCommitWithSourceId("BOE-A-2026-9999", "BOE-A-2025-76"),
			).toBe(false);
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
			expect(await repo.hasCommitWithSourceId("SRC-001", "NORM-A")).toBe(true);
			expect(await repo.hasCommitWithSourceId("SRC-002", "NORM-B")).toBe(true);
			expect(await repo.hasCommitWithSourceId("SRC-003", "NORM-C")).toBe(false);
		});

		test("handles empty repo gracefully", async () => {
			await repo.init();
			await repo.loadExistingCommits();
			expect(await repo.hasCommitWithSourceId("anything")).toBe(false);
		});
	});
});

// ─── Idempotency and TZ-stability tests ─────────────────────────────────────

/**
 * Helper: write + add + commit a single file in the given repo.
 * Returns the repo object so tests can inspect it afterward.
 */
async function writeCommit(
	repoPath: string,
	info: CommitInfo,
	content = info.content,
): Promise<void> {
	const r = new GitRepo(repoPath, "Test Bot", "test@bot.dev");
	await r.init();
	r.writeAndAdd(info.filePath, content);
	await r.add(info.filePath);
	await r.commit(info);
}

/**
 * Count commits in a repo using execSync (reliable in bun test runner).
 */
function countCommits(repoPath: string): number {
	try {
		const GIT_LEAK_VARS = [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		];
		const env = { ...process.env } as Record<string, string>;
		for (const key of GIT_LEAK_VARS) delete env[key];

		const result = execSync("git rev-list --count HEAD", {
			cwd: repoPath,
			env,
		});
		return Number.parseInt(result.toString().trim(), 10);
	} catch {
		return 0;
	}
}

/**
 * Read author dates of all commits via git log (reliable in bun test runner).
 */
function readAuthorDates(repoPath: string): string[] {
	try {
		const GIT_LEAK_VARS = [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_OBJECT_DIRECTORY",
			"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		];
		const env = { ...process.env } as Record<string, string>;
		for (const key of GIT_LEAK_VARS) delete env[key];

		const result = execSync("git log --format=%aI --reverse", {
			cwd: repoPath,
			env,
		});
		return result
			.toString()
			.trim()
			.split("\n")
			.filter((l) => l.trim() !== "");
	} catch {
		return [];
	}
}

describe("Idempotency and TZ-stability", () => {
	let tmpDir1: string;
	let tmpDir2: string;

	afterEach(() => {
		if (tmpDir1)
			try {
				rmSync(tmpDir1, { recursive: true, force: true });
			} catch {}
		if (tmpDir2)
			try {
				rmSync(tmpDir2, { recursive: true, force: true });
			} catch {}
	});

	/**
	 * Test 1 — Idempotency:
	 * Running the writer twice with the same norm+reform produces the same
	 * number of commits after the second run as after the first.
	 */
	test("Test 1 — idempotency: second run adds zero commits", async () => {
		tmpDir1 = join(
			tmpdir(),
			`git-idem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmpDir1, { recursive: true });

		const repoPath = join(tmpDir1, "repo");

		const info = makeCommitInfo({
			trailers: {
				"Source-Id": "BOE-A-2014-2997",
				"Source-Date": "2014-03-21",
				"Norm-Id": "BOE-A-2014-2997",
			},
			authorDate: "2014-03-21",
		});
		const reformInfo = makeCommitInfo({
			subject: "Test Law — reforma art. 9",
			trailers: {
				"Source-Id": "BOE-A-2016-1234",
				"Source-Date": "2016-02-23",
				"Norm-Id": "BOE-A-2014-2997",
			},
			authorDate: "2016-02-23",
			filePath: "es/test.md",
			content: "# Test Law\n\nArticle 1 reformed.",
		});

		// First run — bootstrap + 1 reforma = 2 commits
		const r1 = new GitRepo(repoPath, "Test Bot", "test@bot.dev");
		await r1.init();
		await r1.loadExistingCommits();
		r1.writeAndAdd(info.filePath, info.content);
		await r1.add(info.filePath);
		await r1.commit(info, true);
		r1.writeAndAdd(reformInfo.filePath, reformInfo.content);
		await r1.add(reformInfo.filePath);
		await r1.commit(reformInfo);

		const countAfterFirst = countCommits(repoPath);
		expect(countAfterFirst).toBe(2);

		// Second run — same input, must create 0 new commits
		const r2 = new GitRepo(repoPath, "Test Bot", "test@bot.dev");
		await r2.init();
		await r2.loadExistingCommits();

		// Simulate pipeline logic: skip if already committed
		const skipBootstrap = await r2.hasCommitWithSourceId(
			info.trailers["Source-Id"]!,
			info.trailers["Norm-Id"]!,
		);
		if (!skipBootstrap) {
			r2.writeAndAdd(info.filePath, info.content);
			await r2.add(info.filePath);
			await r2.commit(info, true);
		}

		const skipReform = await r2.hasCommitWithSourceId(
			reformInfo.trailers["Source-Id"]!,
			reformInfo.trailers["Norm-Id"]!,
		);
		if (!skipReform) {
			r2.writeAndAdd(reformInfo.filePath, reformInfo.content);
			await r2.add(reformInfo.filePath);
			await r2.commit(reformInfo);
		}

		const countAfterSecond = countCommits(repoPath);
		expect(countAfterSecond).toBe(countAfterFirst);
	});

	/**
	 * Test 2 — Cross-TZ stability:
	 * Commits made with TZ=Europe/Madrid produce the same ISO author-date
	 * as commits made with TZ=UTC when using the explicit +00:00 offset.
	 * Both repos' commit dates must end with +00:00 (UTC offset).
	 */
	test("Test 2 — cross-TZ: author dates are always UTC (+00:00) regardless of host TZ", async () => {
		tmpDir1 = join(
			tmpdir(),
			`git-tz-test-a-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		tmpDir2 = join(
			tmpdir(),
			`git-tz-test-b-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmpDir1, { recursive: true });
		mkdirSync(tmpDir2, { recursive: true });

		const repoA = join(tmpDir1, "repo");
		const repoB = join(tmpDir2, "repo");

		const info = makeCommitInfo({
			trailers: {
				"Source-Id": "BOE-A-1978-31229",
				"Source-Date": "1978-12-29",
				"Norm-Id": "BOE-A-1978-31229",
			},
			authorDate: "1978-12-29",
		});

		// Repo A — run with TZ=Europe/Madrid in env (simulated by setting process TZ
		// via child process; since we can't change process.env.TZ mid-process safely,
		// we run the writer normally — the commit env forces TZ=UTC internally)
		const origTZ = process.env.TZ;
		process.env.TZ = "Europe/Madrid";
		try {
			await writeCommit(repoA, info);
		} finally {
			if (origTZ === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = origTZ;
			}
		}

		// Repo B — run with TZ=UTC
		process.env.TZ = "UTC";
		try {
			await writeCommit(repoB, info);
		} finally {
			if (origTZ === undefined) {
				delete process.env.TZ;
			} else {
				process.env.TZ = origTZ;
			}
		}

		const datesA = readAuthorDates(repoA);
		const datesB = readAuthorDates(repoB);

		expect(datesA.length).toBeGreaterThan(0);
		expect(datesB.length).toBeGreaterThan(0);

		// All dates must use UTC offset (+00:00 or Z)
		for (const d of [...datesA, ...datesB]) {
			expect(d).toMatch(/\+00:00$|Z$/);
		}

		// Dates from both repos must be identical (TZ doesn't affect the stored value)
		expect(datesA).toEqual(datesB);
	});

	/**
	 * Test 3 — Dedup by Source-Id:
	 * hasCommitWithSourceId correctly finds commits by their Source-Id trailer,
	 * independently of date format or TZ offset.
	 */
	test("Test 3 — dedup by Source-Id: finds correct commit and rejects unknown id", async () => {
		tmpDir1 = join(
			tmpdir(),
			`git-dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tmpDir1, { recursive: true });

		const repoPath = join(tmpDir1, "repo");
		const r = new GitRepo(repoPath, "Test Bot", "test@bot.dev");
		await r.init();

		const info = makeCommitInfo({
			trailers: {
				"Source-Id": "BOE-A-2014-2997",
				"Source-Date": "2014-03-21",
				"Norm-Id": "BOE-A-2014-2997",
			},
			authorDate: "2014-03-21",
		});
		r.writeAndAdd(info.filePath, info.content);
		await r.add(info.filePath);
		await r.commit(info, true);

		// Must find the existing Source-Id
		expect(await r.hasCommitWithSourceId("BOE-A-2014-2997")).toBe(true);
		// Must not find an id that was never committed
		expect(await r.hasCommitWithSourceId("BOE-A-2014-9999")).toBe(false);
	});
});
