/**
 * Re-render of laws whose text the parser used to truncate (blockquote
 * sangrado) — scripts/ad-hoc/reparse-texts.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Block,
	Norm,
	NormMetadata,
} from "../../packages/pipeline/src/models.ts";
import { commitNormsChronologically } from "../../packages/pipeline/src/pipeline.ts";
import {
	extractReforms,
	parseTextXml,
} from "../../packages/pipeline/src/transform/xml-parser.ts";
import { buildReparseCommit, planReparse } from "../ad-hoc/reparse-texts.ts";

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

async function loadNorm(): Promise<Norm> {
	const blocks = parseTextXml(
		await Bun.file(
			join(
				import.meta.dir,
				"../../packages/pipeline/tests/fixtures/constitucion-sample.xml",
			),
		).bytes(),
	);
	return { metadata: META, blocks, reforms: extractReforms(blocks) };
}

/** The same law with quoted text added to the last version of art. 1. */
function withQuote(norm: Norm): Norm {
	const blocks: Block[] = norm.blocks.map((b) =>
		b.id !== "a1"
			? b
			: {
					...b,
					versions: b.versions.map((v, i) =>
						i === b.versions.length - 1
							? {
									...v,
									paragraphs: [
										...v.paragraphs,
										{ cssClass: "sangrado", text: "«Texto citado nuevo.»" },
									],
								}
							: v,
					),
				},
	);
	return { ...norm, blocks };
}

/** The leyes file the pipeline writes for `norm`. */
async function pipelineFile(norm: Norm): Promise<string> {
	const repo = join(mkdtempSync(join(tmpdir(), "reparse-")), "repo");
	await commitNormsChronologically([norm], {
		repoPath: repo,
		dataDir: `${repo}d`,
	});
	return readFileSync(join(repo, REL), "utf-8");
}

describe("planReparse", () => {
	test("same source: nothing to write", async () => {
		const norm = await loadNorm();
		const p = planReparse(REL, await pipelineFile(norm), norm);
		expect(p.state).toBe("match");
		expect(p.content).toBeUndefined();
		expect(p.charsAfter).toBe(p.charsBefore);
	});

	test("source with the quoted text: new content, same date and frontmatter", async () => {
		const norm = await loadNorm();
		const md = await pipelineFile(norm);
		const p = planReparse(REL, md, withQuote(norm));
		expect(p.content).toContain("> «Texto citado nuevo.»");
		expect(p.charsAfter!).toBeGreaterThan(p.charsBefore!);
		const fm = (s: string) => s.slice(0, s.indexOf("\n---", 4));
		expect(fm(p.content!)).toBe(fm(md));
	});

	test("source with a reform the file lacks: left to the pipeline", async () => {
		const norm = await loadNorm();
		const md = await pipelineFile(norm);
		const extra: Norm = {
			...norm,
			reforms: [
				...norm.reforms,
				{ date: "2026-10-01", normId: "BOE-A-2026-1", affectedBlockIds: [] },
			],
		};
		const p = planReparse(REL, md, extra);
		expect(p.state).toBe("source-newer");
		expect(p.content).toBeUndefined();
	});

	test("no source, no file", async () => {
		const md = await pipelineFile(await loadNorm());
		expect(planReparse(REL, md, undefined).state).toBe("missing");
		expect(planReparse(REL, undefined, undefined).state).toBe("no-file");
	});

	test("source at another path: skipped", async () => {
		const norm = await loadNorm();
		const md = await pipelineFile(norm);
		const p = planReparse("es-an/BOE-A-1978-31229.md", md, withQuote(norm));
		expect(p.skipReason).toContain("es/BOE-A-1978-31229.md");
		expect(p.content).toBeUndefined();
	});
});

test("commit: fix-pipeline, no Source-Id, dated today", async () => {
	const norm = await loadNorm();
	const p = planReparse(REL, await pipelineFile(norm), withQuote(norm));
	const c = buildReparseCommit(
		norm,
		{ ...p, renderedAt: p.renderedAt! },
		"2026-10-01",
	);
	expect(c.commitType).toBe("fix-pipeline");
	expect(c.subject).toBe("Constitución Española — texto completo");
	expect(c.trailers).toEqual({
		"Source-Date": p.renderedAt!,
		"Norm-Id": META.id,
	});
	expect(c.authorDate).toBe("2026-10-01");
});
