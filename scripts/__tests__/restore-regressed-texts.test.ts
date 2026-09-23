/**
 * A5b: detection + regeneration of laws whose text regressed to an older
 * version before PR #170 (scripts/ad-hoc/restore-regressed-texts.ts).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../../packages/api/src/services/git.ts";
import type {
	Block,
	Norm,
	NormAnalisis,
	NormMetadata,
} from "../../packages/pipeline/src/models.ts";
import { commitNormsChronologically } from "../../packages/pipeline/src/pipeline.ts";
import { renderNormAtDate } from "../../packages/pipeline/src/transform/markdown.ts";
import {
	extractReforms,
	parseTextXml,
} from "../../packages/pipeline/src/transform/xml-parser.ts";
import {
	applyPlans,
	inspectFile,
	isRegenerable,
	parseAllowList,
	parseFileFrontmatter,
	planFinding,
	restrictToAllowList,
	scanRepo,
} from "../ad-hoc/restore-regressed-texts.ts";

const META: NormMetadata = {
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
const REL = "es/BOE-A-1978-31229.md";
const NOW = new Date("2026-09-23T00:00:00Z");
const ANALISIS: NormAnalisis = {
	materias: ["Derecho constitucional"],
	notas: [],
	referencias: {
		anteriores: [],
		posteriores: [
			{ normId: "BOE-A-1985-12666", relation: "SE DESARROLLA", text: "LOPJ" },
		],
	},
};

async function loadNorm(): Promise<Norm> {
	const blocks = parseTextXml(
		await Bun.file(
			join(
				import.meta.dir,
				"../../packages/pipeline/tests/fixtures/constitucion-sample.xml",
			),
		).bytes(),
	);
	// Reforms: 1978-12-29, 1992-08-28, 2011-09-27 (art. 135), 2024-02-17 (art. 49)
	return { metadata: META, blocks, reforms: extractReforms(blocks) };
}

const redate = (norm: Norm, normId: string, date: string): Norm => {
	const blocks: Block[] = norm.blocks.map((b) => ({
		...b,
		versions: b.versions.map((v) =>
			v.normId === normId ? { ...v, publishedAt: date, effectiveAt: date } : v,
		),
	}));
	return { ...norm, blocks, reforms: extractReforms(blocks) };
};

const renderAt = (norm: Norm, date: string, analisis?: NormAnalisis) =>
	renderNormAtDate(norm.metadata, norm.blocks, date, norm.reforms, analisis);

describe("detection", () => {
	test("a file rendered at an older date than its last reform is flagged", async () => {
		const norm = await loadNorm();
		// What the pre-#170 pipeline left behind: full `reformas`, old text.
		const md = renderAt(norm, "1992-08-28");
		const f = inspectFile(REL, md, NOW);
		expect(f).toMatchObject({
			id: "BOE-A-1978-31229",
			jurisdiction: "es",
			renderedAt: "1992-08-28",
			expected: "2024-02-17",
		});
	});

	test("a file rendered at its last reform is not flagged", async () => {
		const norm = await loadNorm();
		expect(inspectFile(REL, renderAt(norm, "2024-02-17"), NOW)).toBeNull();
	});

	test("a 2929 reform is ignored as a render target", async () => {
		// BOE-A-1985-26400 style: one version carries fecha_publicacion 29291119.
		const norm = redate(await loadNorm(), "BOE-A-2024-3099", "2929-11-19");
		// Rendered at the latest *plausible* reform: fine.
		expect(inspectFile(REL, renderAt(norm, "2011-09-27"), NOW)).toBeNull();
		// Rendered AT 2929 (pre-#170 behaviour): contains every version, fine.
		expect(inspectFile(REL, renderAt(norm, "2929-11-19"), NOW)).toBeNull();
		// Genuinely behind: the target is 2011-09-27, never 2929-11-19.
		expect(inspectFile(REL, renderAt(norm, "1992-08-28"), NOW)?.expected).toBe(
			"2011-09-27",
		);
	});

	test("files without frontmatter or reforms are ignored", () => {
		expect(inspectFile(REL, "# Sin frontmatter\n", NOW)).toBeNull();
		expect(
			inspectFile(REL, '---\nultima_actualizacion: "2020-01-01"\n---\n', NOW),
		).toBeNull();
	});

	test("analisis is read back from the file", async () => {
		const md = renderAt(await loadNorm(), "2024-02-17", ANALISIS);
		expect(parseFileFrontmatter(md)?.analisis).toEqual(ANALISIS);
	});

	test("scanRepo finds only the regressed file", async () => {
		const norm = await loadNorm();
		const repo = mkdtempSync(join(tmpdir(), "a5b-scan-"));
		await Bun.write(join(repo, REL), renderAt(norm, "2011-09-27"));
		await Bun.write(
			join(repo, "es-ct/DOGC-f-2000-1.md"),
			renderAt(norm, "2024-02-17"),
		);
		const { scanned, findings } = scanRepo(repo, NOW);
		expect(scanned).toBe(2);
		expect(findings.map((f) => f.id)).toEqual(["BOE-A-1978-31229"]);
	});
});

describe("planning", () => {
	test("regressed file: text changes, render reproduces the old file", async () => {
		const norm = await loadNorm();
		const md = renderAt(norm, "1992-08-28", ANALISIS);
		const plan = planFinding(inspectFile(REL, md, NOW)!, md, norm, norm);
		expect(isRegenerable(plan)).toBe(true);
		expect(plan.textChanged).toBe(true);
		expect(plan.reproduces).toBe(true);
		// Same as the pipeline's render at the right date, analisis preserved.
		expect(plan.content).toBe(renderAt(norm, "2024-02-17", ANALISIS));
	});

	test("source with a reform the file lacks is not regenerated", async () => {
		const full = await loadNorm();
		const md = renderAt(full, "1992-08-28");
		const newer: Norm = {
			...full,
			reforms: [
				...full.reforms,
				{ date: "2026-01-01", normId: "BOE-A-2026-1", affectedBlockIds: [] },
			],
		};
		const plan = planFinding(inspectFile(REL, md, NOW)!, md, newer, full);
		expect(plan.state).toBe("source-newer");
		expect(isRegenerable(plan)).toBe(false);
	});

	test("source lacking a reform the file has is not regenerated", async () => {
		const full = await loadNorm();
		const md = renderAt(full, "1992-08-28");
		const older: Norm = { ...full, reforms: full.reforms.slice(0, -1) };
		const plan = planFinding(inspectFile(REL, md, NOW)!, md, older, full);
		expect(plan.state).toBe("source-older");
		expect(isRegenerable(plan)).toBe(false);
	});

	test("a jurisdiction disagreement with the JSON cache is not regenerated", async () => {
		const norm = await loadNorm();
		const md = renderAt(norm, "1992-08-28");
		const cache: Norm = {
			...norm,
			metadata: {
				...META,
				source: "https://www.boe.es/eli/es-ct/l/1978/12/27/(1)",
			},
		};
		const plan = planFinding(inspectFile(REL, md, NOW)!, md, norm, cache);
		expect(plan.skipReason).toContain("es-ct/BOE-A-1978-31229.md");
		expect(isRegenerable(plan)).toBe(false);
	});
});

describe("allow-list (--only)", () => {
	test("parses one ID per line, ignoring comments and blanks", () => {
		expect(
			parseAllowList(
				"# revisado el 23/09\nBOE-A-1978-31229\n\n  BOE-A-2015-11430  # ET\n",
			),
		).toEqual(new Set(["BOE-A-1978-31229", "BOE-A-2015-11430"]));
		expect(parseAllowList("# vacío: solo informe\n").size).toBe(0);
	});

	test("a regenerable law that is not listed is left alone", async () => {
		const norm = await loadNorm();
		const md = renderAt(norm, "1992-08-28");
		const plan = planFinding(inspectFile(REL, md, NOW)!, md, norm, norm);
		expect(isRegenerable(plan)).toBe(true);
		const [kept] = restrictToAllowList([plan], new Set(["BOE-A-1978-31229"]));
		expect(isRegenerable(kept!)).toBe(true);
		const [blocked] = restrictToAllowList([plan], new Set());
		expect(isRegenerable(blocked!)).toBe(false);
		expect(blocked!.skipReason).toContain("lista autorizada");
	});
});

describe("apply", () => {
	function git(repo: string, args: string[]): string {
		const env = { ...process.env } as Record<string, string>;
		for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"])
			delete env[k];
		return Bun.spawnSync(["git", ...args], {
			cwd: repo,
			env,
		}).stdout.toString();
	}

	test("commits the correction once, then is a no-op", async () => {
		const norm = await loadNorm();
		const repo = join(mkdtempSync(join(tmpdir(), "a5b-apply-")), "repo");
		// Real pipeline history, then simulate the pre-#170 regression commit.
		await commitNormsChronologically([norm], {
			repoPath: repo,
			dataDir: `${repo}d`,
		});
		await Bun.write(join(repo, REL), renderAt(norm, "1992-08-28"));
		git(repo, ["add", REL]);
		git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "regresión"]);

		const run = async () => {
			const { findings } = scanRepo(repo, NOW);
			const plans = findings.map((f) => {
				const md = readFileSync(join(repo, f.relPath), "utf-8");
				return planFinding(f, md, norm, norm);
			});
			return applyPlans(
				repo,
				plans,
				new Map([[norm.metadata.id, norm]]),
				"2026-09-23",
			);
		};

		expect((await run()).committed).toEqual(["BOE-A-1978-31229"]);
		expect(readFileSync(join(repo, REL), "utf-8")).toBe(
			renderAt(norm, "2024-02-17"),
		);
		const head = git(repo, [
			"log",
			"-1",
			"--format=%an <%ae>|%ad|%s%n%B",
			"--date=short",
		]);
		expect(head).toContain("Ley Abierta <bot@leyabierta.es>|2026-09-23|");
		expect(head).toContain(
			"Constitución Española — texto restaurado a la versión vigente",
		);
		expect(head).toContain("Source-Date: 2024-02-17");
		expect(head).toContain("Norm-Id: BOE-A-1978-31229");
		expect(head).not.toContain("Source-Id:");

		const again = await run();
		expect(again.committed).toEqual([]);
		expect(scanRepo(repo, NOW).findings).toEqual([]);

		// The API's versions/diff endpoints pick commits by Source-Date: from
		// the latest reform on they must serve the corrected text.
		const corrected = renderAt(norm, "2024-02-17");
		const api = new GitService(repo);
		expect(await api.getFileAtDate(REL, "2024-02-17")).toBe(corrected);
		expect(await api.getFileAtDate(REL, "2026-09-23")).toBe(corrected);

		// The next daily run (same reforms, no Source-Id on the correction)
		// must neither re-commit the reforms nor roll the file back.
		const before = git(repo, ["rev-parse", "HEAD"]);
		const created = await commitNormsChronologically([norm], {
			repoPath: repo,
			dataDir: `${repo}d`,
		});
		expect(created).toBe(0);
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(before);
		expect(readFileSync(join(repo, REL), "utf-8")).toBe(corrected);
	});
});
