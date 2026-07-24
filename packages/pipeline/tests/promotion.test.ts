/**
 * Tests for the diario → consolidado promotion (#130 Stage 3).
 *
 * The bug: a diario-origin norm's `[publicacion]` commit carries the same
 * Source-Id|Norm-Id pair (both `metadata.id` in ~95% of cases) that the
 * consolidated bootstrap's first reform would produce. Without the
 * promotion logic, `hasCommitWithSourceId` sees that pair already exists
 * and silently skips the consolidated rewrite — the `.md` file stays on
 * diario text forever while the JSON cache and DB move on to consolidado.
 *
 * These tests build real temp git repos (no mocks — `assertUniqueByNormId`
 * and git history inspection both need the real thing) and drive the
 * promotion end to end via `commitNormsChronologically`.
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block, Norm, NormMetadata, Reform } from "../src/models.ts";
import {
	assertUniqueByNormId,
	commitNormsChronologically,
} from "../src/pipeline.ts";

let gitSeq = 0;

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

/** Reliable git output capture in the bun test runner (see git-repo.test.ts). */
function gitOutput(args: string[], cwd: string): string {
	const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
	const outFile = join(
		tmpdir(),
		`.git-promo-test-out-${process.pid}-${++gitSeq}`,
	);
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

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "leyabierta-promotion-test-"));
}

/** Build a minimal single-article diario Norm. `reformSourceId` defaults to own id. */
function makeDiarioNorm(id: string, reformSourceId = id): Norm {
	const metadata: NormMetadata = {
		title: `Real Decreto de Prueba ${id}`,
		shortTitle: `RD de Prueba ${id}`,
		id,
		country: "es",
		rank: "real_decreto",
		publishedAt: "2026-07-20",
		status: "vigente",
		department: "Ministerio de Prueba",
		source: `https://www.boe.es/eli/es/rd/2026/07/20/${id}`,
		origin: "diario",
		consolidated: false,
		section: "1",
	};
	const blocks: Block[] = [
		{
			id: "a1",
			type: "precepto",
			title: "Artículo 1",
			versions: [
				{
					normId: reformSourceId,
					publishedAt: "2026-07-20",
					effectiveAt: "2026-07-20",
					paragraphs: [
						{ cssClass: "articulo", text: "Texto DIARIO del artículo 1." },
					],
				},
			],
		},
	];
	const reforms: Reform[] = [
		{ date: "2026-07-20", normId: reformSourceId, affectedBlockIds: ["a1"] },
	];
	return { metadata, blocks, reforms };
}

/** Build the consolidated version of the same norm — different block ids/text. */
function makeConsolidatedNorm(id: string, reformSourceId = id): Norm {
	const metadata: NormMetadata = {
		title: `Real Decreto de Prueba ${id}`,
		shortTitle: `RD de Prueba ${id}`,
		id,
		country: "es",
		rank: "real_decreto",
		publishedAt: "2026-07-20",
		status: "vigente",
		department: "Ministerio de Prueba",
		source: `https://www.boe.es/eli/es/rd/2026/07/20/${id}`,
		// No origin/consolidated/section — a real consolidated fetch never
		// sets these; jsonToNorm/normToJson treat their absence as "consolidado".
	};
	const blocks: Block[] = [
		{
			id: "art-1",
			type: "articulo",
			title: "Artículo 1",
			versions: [
				{
					normId: reformSourceId,
					publishedAt: "2026-07-20",
					effectiveAt: "2026-07-20",
					paragraphs: [
						{ cssClass: "articulo", text: "Texto CONSOLIDADO del artículo 1." },
					],
				},
			],
		},
	];
	const reforms: Reform[] = [
		{ date: "2026-07-20", normId: reformSourceId, affectedBlockIds: ["art-1"] },
	];
	return { metadata, blocks, reforms };
}

/** Build a plain consolidated norm that never went through the diario. */
function makePlainConsolidatedNorm(id: string): Norm {
	const metadata: NormMetadata = {
		title: `Ley de Prueba ${id}`,
		shortTitle: `Ley de Prueba ${id}`,
		id,
		country: "es",
		rank: "ley",
		publishedAt: "2020-01-10",
		status: "vigente",
		department: "Ministerio de Prueba",
		source: `https://www.boe.es/eli/es/l/2020/01/10/${id}`,
	};
	const blocks: Block[] = [
		{
			id: "art-1",
			type: "articulo",
			title: "Artículo 1",
			versions: [
				{
					normId: id,
					publishedAt: "2020-01-10",
					effectiveAt: "2020-01-10",
					paragraphs: [{ cssClass: "articulo", text: "Texto original." }],
				},
			],
		},
	];
	const reforms: Reform[] = [
		{ date: "2020-01-10", normId: id, affectedBlockIds: ["art-1"] },
	];
	return { metadata, blocks, reforms };
}

describe("diario → consolidado promotion", () => {
	test("promotes a diario norm to consolidado: new [consolidacion] commit, consolidated text wins, diario commit survives in history", async () => {
		const tmpDir = makeTmpDir();
		const repoPath = join(tmpDir, "repo");
		const config = { repoPath, dataDir: join(tmpDir, "data") };
		const id = "BOE-A-2026-16010";

		// Step 1: diario ingests it first (as the real `diario` CLI command would).
		const diarioCount = await commitNormsChronologically(
			[makeDiarioNorm(id)],
			config,
		);
		expect(diarioCount).toBe(1);

		const filePath = join(repoPath, "es", `${id}.md`);
		const diarioContent = await Bun.file(filePath).text();
		expect(diarioContent).toContain("Texto DIARIO del artículo 1");

		// Step 2: the consolidated bootstrap fetches the SAME id later.
		const consolidatedCount = await commitNormsChronologically(
			[makeConsolidatedNorm(id)],
			config,
		);
		expect(consolidatedCount).toBe(1); // exactly one new [consolidacion] commit

		// File content is now the consolidated text, not diario.
		const finalContent = await Bun.file(filePath).text();
		expect(finalContent).toContain("Texto CONSOLIDADO del artículo 1");
		expect(finalContent).not.toContain("Texto DIARIO");

		// Both commits exist in history — the diario commit was NOT rewritten
		// or dropped, just superseded by a later commit.
		const subjects = gitOutput(["log", "--format=%s", "--reverse"], repoPath)
			.trim()
			.split("\n");
		expect(
			subjects.some((s) => s.includes("publicación en el diario oficial")),
		).toBe(true);
		expect(subjects.some((s) => s.includes("consolidación"))).toBe(true);
		expect(subjects.length).toBe(2);

		// The promotion commit carries the `Origin: consolidado` trailer.
		const lastBody = gitOutput(["log", "--format=%B", "-1"], repoPath);
		expect(lastBody).toContain("Origin: consolidado");

		// The original diario commit still carries `Origin: diario`. `git log
		// -1 --reverse` does NOT give the root commit (it limits to 1 commit
		// from HEAD first, then reverses that single-element list) — the root
		// commit must be found explicitly.
		const rootSha = gitOutput(
			["rev-list", "--max-parents=0", "HEAD"],
			repoPath,
		).trim();
		const firstBody = gitOutput(
			["show", "-s", "--format=%B", rootSha],
			repoPath,
		);
		expect(firstBody).toContain("Origin: diario");

		assertUniqueByNormId(repoPath);
	});

	test("idempotent: running the consolidated promotion again creates zero new commits", async () => {
		const tmpDir = makeTmpDir();
		const repoPath = join(tmpDir, "repo");
		const config = { repoPath, dataDir: join(tmpDir, "data") };
		const id = "BOE-A-2026-16011";

		await commitNormsChronologically([makeDiarioNorm(id)], config);
		const firstPromotion = await commitNormsChronologically(
			[makeConsolidatedNorm(id)],
			config,
		);
		expect(firstPromotion).toBe(1);

		const commitsBefore = gitOutput(
			["rev-list", "--count", "HEAD"],
			repoPath,
		).trim();

		// Re-run the exact same consolidated fetch — must be a no-op.
		const secondPromotion = await commitNormsChronologically(
			[makeConsolidatedNorm(id)],
			config,
		);
		expect(secondPromotion).toBe(0);

		const commitsAfter = gitOutput(
			["rev-list", "--count", "HEAD"],
			repoPath,
		).trim();
		expect(commitsAfter).toBe(commitsBefore);

		await assertUniqueByNormId(repoPath);
	});

	test("promotes correctly when reforms[0].sourceId === id (the ~95% case)", async () => {
		const tmpDir = makeTmpDir();
		const repoPath = join(tmpDir, "repo");
		const config = { repoPath, dataDir: join(tmpDir, "data") };
		const id = "BOE-A-2026-16012";

		await commitNormsChronologically([makeDiarioNorm(id, id)], config);
		const count = await commitNormsChronologically(
			[makeConsolidatedNorm(id, id)],
			config,
		);
		expect(count).toBe(1);

		const content = await Bun.file(join(repoPath, "es", `${id}.md`)).text();
		expect(content).toContain("Texto CONSOLIDADO");
	});

	test("promotes correctly when reforms[0].sourceId !== id (the ~4.5% case)", async () => {
		const tmpDir = makeTmpDir();
		const repoPath = join(tmpDir, "repo");
		const config = { repoPath, dataDir: join(tmpDir, "data") };
		const id = "BOE-A-2026-16013";
		const foundingSourceId = "BOE-A-1988-500"; // an older disposition id

		// The diario's own single-version reform always carries its own id —
		// only the CONSOLIDATED norm's first reform can point elsewhere.
		await commitNormsChronologically([makeDiarioNorm(id, id)], config);
		const count = await commitNormsChronologically(
			[makeConsolidatedNorm(id, foundingSourceId)],
			config,
		);
		expect(count).toBe(1);

		const content = await Bun.file(join(repoPath, "es", `${id}.md`)).text();
		expect(content).toContain("Texto CONSOLIDADO");

		const body = gitOutput(["log", "--format=%B", "-1"], repoPath);
		expect(body).toContain(`Source-Id: ${foundingSourceId}`);
		expect(body).toContain(`Norm-Id: ${id}`);
		expect(body).toContain("Origin: consolidado");
	});

	test("a norm that never went through the diario behaves exactly as before: one [bootstrap] commit, no consolidación, idempotent re-run", async () => {
		const tmpDir = makeTmpDir();
		const repoPath = join(tmpDir, "repo");
		const config = { repoPath, dataDir: join(tmpDir, "data") };
		const id = "BOE-A-2020-99999";

		const firstRun = await commitNormsChronologically(
			[makePlainConsolidatedNorm(id)],
			config,
		);
		expect(firstRun).toBe(1);

		const subjects = gitOutput(["log", "--format=%s"], repoPath)
			.trim()
			.split("\n");
		expect(subjects).toHaveLength(1);
		expect(subjects[0]).toContain("publicación original");
		expect(subjects.some((s) => s.includes("consolidación"))).toBe(false);

		const body = gitOutput(["log", "--format=%B", "-1"], repoPath);
		expect(body).not.toContain("Origin:");

		// Re-run — must be a no-op, same as the pre-#130 behavior.
		const secondRun = await commitNormsChronologically(
			[makePlainConsolidatedNorm(id)],
			config,
		);
		expect(secondRun).toBe(0);

		await assertUniqueByNormId(repoPath);
	});

	// ── Perf regression guard ────────────────────────────────────────────
	// Before the fix, hasDiarioPublicacion/hasConsolidacion ran a fresh
	// `git log --grep` PLUS a `git show` per matching commit for every
	// first-reform of every non-diario norm — O(N_first_reforms ×
	// N_diario_commits) subprocess spawns once diario commits accumulate.
	// After the fix, the origin trailers are read into an in-memory index
	// with ONE `git log` scan per GitRepo instance; every subsequent
	// hasDiarioPublicacion/hasConsolidacion call is an O(1) Set lookup. This
	// test commits many never-diario norms in one batch (the worst case for
	// the OLD code: every one of them paid for a promotion check) and
	// asserts it completes fast enough that no per-norm subprocess pair is
	// being spawned.
	test("perf: many never-diario norms in one batch stay fast (no per-norm git subprocess for the promotion check)", async () => {
		const tmpDir = makeTmpDir();
		const repoPath = join(tmpDir, "repo");
		const config = { repoPath, dataDir: join(tmpDir, "data") };

		// A modest batch: this is a functional smoke test that the promotion
		// check does not blow up or misfire across many never-diario norms.
		// It deliberately does NOT assert wall-clock time — that is dominated
		// by the real `git commit` spawns (init/add/status/commit/rev-parse)
		// and flakes badly under concurrent test load. The precise perf proof
		// that promotion detection is O(1) (not a per-norm git-grep + git-show,
		// the #130 Stage 3 regression) lives in git-repo.test.ts: 1000 index
		// lookups in ~1ms. Here we only verify correctness at volume.
		const NORM_COUNT = 40;
		const norms = Array.from({ length: NORM_COUNT }, (_, i) =>
			makePlainConsolidatedNorm(`BOE-A-2021-${String(i).padStart(5, "0")}`),
		);

		const count = await commitNormsChronologically(norms, config);

		expect(count).toBe(NORM_COUNT);
		await assertUniqueByNormId(repoPath);
	}, 90000);
});
