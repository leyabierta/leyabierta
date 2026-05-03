/**
 * Tests for cross-jurisdiction duplicate detection.
 *
 * Covers:
 *  1. writeAndAdd rejects a norm ID that already exists in another jurisdiction
 *  2. writeAndAdd allows the same path (idempotency)
 *  3. assertUniqueByNormId throws when duplicates exist
 *  4. assertUniqueByNormId passes for a well-formed repo
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepo } from "../src/git/repo.ts";
import { assertUniqueByNormId } from "../src/pipeline.ts";

let tempDir: string;
let repo: GitRepo;

beforeEach(async () => {
	tempDir = join(
		tmpdir(),
		`jurisdiction-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });
	repo = new GitRepo(tempDir, "Test Bot", "test@bot.dev");
	await repo.init();
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// ── Test 1 — writeAndAdd rejects ID duplicate across jurisdictions ────────────

describe("writeAndAdd cross-jurisdiction duplicate detection", () => {
	test("Test 1 — rejects same norm ID in a different jurisdiction folder", () => {
		const content = "# Ley de Andalucía\n\nArtículo 1.";

		// First write: es-an is the correct jurisdiction — must succeed
		const changed = repo.writeAndAdd("es-an/BOE-A-2026-7558.md", content);
		expect(changed).toBe(true);
		expect(existsSync(join(tempDir, "es-an", "BOE-A-2026-7558.md"))).toBe(true);

		// Second write: same ID but wrong jurisdiction — must throw
		expect(() => repo.writeAndAdd("es/BOE-A-2026-7558.md", content)).toThrow(
			/same id.*exists.*es-an/,
		);

		// The wrongly-placed file must NOT have been created
		expect(existsSync(join(tempDir, "es", "BOE-A-2026-7558.md"))).toBe(false);
	});

	test("Test 1b — error message includes 'same id exists' and the conflicting path", () => {
		repo.writeAndAdd("es-pv/BOE-A-2026-1111.md", "# Ley Vasca");

		let caughtMessage = "";
		try {
			repo.writeAndAdd("es/BOE-A-2026-1111.md", "# Ley Vasca mal puesta");
		} catch (err) {
			caughtMessage = (err as Error).message;
		}

		expect(caughtMessage).toContain("same id");
		expect(caughtMessage).toContain("exists");
		expect(caughtMessage).toContain("es-pv");
	});

	// ── Test 2 — idempotency: same path is fine ────────────────────────────────

	test("Test 2a — same jurisdiction + same content returns false (no-op)", () => {
		const content = "# Ley Andalucía v1.";
		repo.writeAndAdd("es-an/BOE-A-2026-7558.md", content);

		// Identical write to same path: must return false, no error
		const changed = repo.writeAndAdd("es-an/BOE-A-2026-7558.md", content);
		expect(changed).toBe(false);
	});

	test("Test 2b — same jurisdiction + different content returns true (update)", () => {
		repo.writeAndAdd("es-an/BOE-A-2026-7558.md", "# Version 1");

		const changed = repo.writeAndAdd("es-an/BOE-A-2026-7558.md", "# Version 2");
		expect(changed).toBe(true);
	});

	test("Test 2c — allows updating an existing file even if a stale duplicate sits in another folder", () => {
		// Simulate the broken state: two files for the same id, one canonical
		// (es-an/) and one stale (es/). Bypass the writer to set this up.
		mkdirSync(join(tempDir, "es-an"), { recursive: true });
		mkdirSync(join(tempDir, "es"), { recursive: true });
		writeFileSync(
			join(tempDir, "es-an", "BOE-A-2026-7558.md"),
			"# Canonical v1",
			"utf-8",
		);
		writeFileSync(
			join(tempDir, "es", "BOE-A-2026-7558.md"),
			"# Stale duplicate",
			"utf-8",
		);

		// The pipeline must still be able to UPDATE the canonical file. The
		// stale duplicate is the operator's problem to clean up; it must not
		// block legitimate writes.
		const changed = repo.writeAndAdd(
			"es-an/BOE-A-2026-7558.md",
			"# Canonical v2 (updated)",
		);
		expect(changed).toBe(true);

		// But writing to a NEW path (different jurisdiction, file does not
		// yet exist) must still be rejected.
		expect(() =>
			repo.writeAndAdd("es-pv/BOE-A-2026-7558.md", "# Wrong place"),
		).toThrow(/same id "BOE-A-2026-7558" already exists/);
	});

	test("Test 2d — error message includes a remediation hint", () => {
		repo.writeAndAdd("es-an/BOE-A-2026-7558.md", "# Andalusian content");

		expect(() =>
			repo.writeAndAdd("es/BOE-A-2026-7558.md", "# Wrong jurisdiction"),
		).toThrow(/git -C .* rm /);
	});

	test("Test 2e — non-norm files (README, index) skip the invariant check", () => {
		// READMEs and similar housekeeping files can legitimately exist in
		// multiple folders. The pre-write check must not pretend they are
		// norms and refuse the write.
		repo.writeAndAdd("es/README.md", "# es readme");
		repo.writeAndAdd("es-an/README.md", "# es-an readme");
		// If the check incorrectly fired, the second call would have thrown.
		expect(existsSync(join(tempDir, "es/README.md"))).toBe(true);
		expect(existsSync(join(tempDir, "es-an/README.md"))).toBe(true);
	});

	test("Test 2f — index reflects writes from this same GitRepo instance", () => {
		// First write populates the lazy index. Second write to a DIFFERENT
		// jurisdiction must be rejected based on the cached entry, even
		// though the file exists physically (same instance saw it).
		repo.writeAndAdd("es-an/BOE-A-2026-7558.md", "# v1");
		expect(() =>
			repo.writeAndAdd("es-pv/BOE-A-2026-7558.md", "# wrong"),
		).toThrow(/already exists/);
	});
});

// ── Test 3 — assertUniqueByNormId detects duplicates ─────────────────────────

describe("assertUniqueByNormId", () => {
	test("Test 3 — throws with conflict list when same ID exists in two jurisdictions", async () => {
		// Write files directly (bypassing GitRepo) to simulate a broken repo
		// as might result from an ad-hoc backfill script.
		mkdirSync(join(tempDir, "es"), { recursive: true });
		mkdirSync(join(tempDir, "es-an"), { recursive: true });
		writeFileSync(join(tempDir, "es-an", "BOE-A-2026-7558.md"), "# Andalucía");
		writeFileSync(join(tempDir, "es", "BOE-A-2026-7558.md"), "# Duplicado");

		await expect(assertUniqueByNormId(tempDir)).rejects.toThrow(
			/BOE-A-2026-7558/,
		);
	});

	test("Test 3b — error message lists all conflicting jurisdictions", async () => {
		mkdirSync(join(tempDir, "es"), { recursive: true });
		mkdirSync(join(tempDir, "es-nc"), { recursive: true });
		writeFileSync(join(tempDir, "es-nc", "BOE-A-2026-9047.md"), "# Navarra");
		writeFileSync(join(tempDir, "es", "BOE-A-2026-9047.md"), "# Mal puesta");

		let caughtMessage = "";
		try {
			await assertUniqueByNormId(tempDir);
		} catch (err) {
			caughtMessage = (err as Error).message;
		}

		expect(caughtMessage).toContain("BOE-A-2026-9047");
		expect(caughtMessage).toContain("es-nc");
		expect(caughtMessage).toContain("es");
	});

	// ── Test 4 — assertUniqueByNormId passes for a well-formed repo ──────────

	test("Test 4 — does not throw when all IDs are unique across jurisdictions", async () => {
		mkdirSync(join(tempDir, "es"), { recursive: true });
		mkdirSync(join(tempDir, "es-an"), { recursive: true });
		mkdirSync(join(tempDir, "es-nc"), { recursive: true });

		// Different IDs in different jurisdictions — no conflict
		writeFileSync(join(tempDir, "es", "BOE-A-2026-1000.md"), "# Estado");
		writeFileSync(join(tempDir, "es-an", "BOE-A-2026-7558.md"), "# Andalucía");
		writeFileSync(join(tempDir, "es-nc", "BOE-A-2026-9047.md"), "# Navarra");

		// Must resolve without throwing
		await expect(assertUniqueByNormId(tempDir)).resolves.toBeUndefined();
	});

	test("Test 4b — passes for empty repo (no jurisdiction folders)", async () => {
		// tempDir has no subdirs at all
		await expect(assertUniqueByNormId(tempDir)).resolves.toBeUndefined();
	});

	test("Test 4c — passes for non-existent repo path", async () => {
		await expect(
			assertUniqueByNormId(join(tempDir, "nonexistent")),
		).resolves.toBeUndefined();
	});
});
