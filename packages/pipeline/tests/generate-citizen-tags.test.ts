/**
 * End to end: runs the daily cron script (generate-citizen-tags.ts) against a
 * temporary DB with fetch mocked by a preload, and checks that per-article
 * summaries go through the shared generator (same request as the lazy and RAG
 * paths, whole article, traceability columns written), that existing article
 * summaries are never lost, and that an API refusing everything fails the run.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { articleSummaryRequestBody } from "../src/ai/article-summary.ts";
import { createSchema } from "../src/db/schema.ts";

const SCRIPT = resolve(
	import.meta.dir,
	"../src/scripts/generate-citizen-tags.ts",
);
const LONG_ARTICLE = `Artículo 1. Objeto.\n${"La administración deberá resolver la solicitud en el plazo de tres meses desde su presentación. ".repeat(20)}`;
const SHORT_ARTICLE =
	"Artículo 2. Plazo.\nEl interesado podrá recurrir la resolución en el plazo de un mes.";
const OLD_SUMMARY = "Resumen previo del backfill offline del artículo segundo.";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let dir: string;
let dbPath: string;
let bodiesPath: string;

/** mock fetch: the law call answers JSON; article calls answer `articleStatus`. */
function writeMock(articleStatus: number) {
	writeFileSync(
		join(dir, "mock-fetch.ts"),
		`import { appendFileSync } from "node:fs";
globalThis.fetch = (async (_url, init) => {
	const body = JSON.parse(String(init.body));
	appendFileSync(${JSON.stringify(bodiesPath)}, JSON.stringify(body) + "\\n");
	const law = body.response_format?.json_schema?.name === "law_citizen_metadata";
	if (!law && ${articleStatus} !== 200)
		return new Response("Insufficient credits", { status: ${articleStatus} });
	const content = law
		? JSON.stringify({ citizen_tags: ["trámites", "plazos"], citizen_summary: "Regula los plazos de las solicitudes." })
		: JSON.stringify({ articles: [{ article_id: "ARTÍCULO_1", citizen_summary: "La administración resuelve las solicitudes en un plazo de tres meses desde su presentación.", citizen_tags: ["plazos", "solicitudes", "administración"] }] });
	return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0001 } }), { status: 200 });
}) as typeof fetch;
`,
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "citizen-tags-"));
	dirs.push(dir);
	dbPath = join(dir, "test.db");
	bodiesPath = join(dir, "bodies.jsonl");
	const db = new Database(dbPath);
	createSchema(db);
	db.run(
		"INSERT INTO norms (id, title, country, rank, published_at, status, citizen_summary) VALUES ('N', 'Ley de prueba', 'es', 'ley', '2026-09-01', 'vigente', '')",
	);
	const insert = db.prepare(
		"INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', ?, ?, ?, ?, ?)",
	);
	insert.run("a1", "precepto", "Artículo 1", 1, LONG_ARTICLE);
	insert.run("a2", "precepto", "Artículo 2", 2, SHORT_ARTICLE);
	insert.run("a3", "precepto", "Artículo 3", 3, "Artículo 3.\n(Derogado)");
	insert.run("pr", "preambulo", "Preámbulo", 0, LONG_ARTICLE);
	db.close();
	writeMock(200);
});

async function runCron(
	extraArgs: string[] = [],
	extraEnv: Record<string, string> = {},
) {
	const proc = Bun.spawn(
		[
			"bun",
			"--preload",
			join(dir, "mock-fetch.ts"),
			SCRIPT,
			"--norm-id",
			"N",
			...extraArgs,
		],
		{
			env: {
				...process.env,
				DB_PATH: dbPath,
				OPENROUTER_API_KEY: "test-key",
				OPENROUTER_BACKOFF_MS: "0",
				ARTICLE_SUMMARIES_MODEL: "",
				ARTICLE_SUMMARIES_MAX_PER_RUN: "",
				OPENROUTER_ZDR: "",
				...extraEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return proc.exited;
}

function bodies(): Record<string, unknown>[] {
	if (!existsSync(bodiesPath)) return [];
	return readFileSync(bodiesPath, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
}
const articleBodies = () =>
	bodies().filter(
		(b) =>
			(b.response_format as { json_schema?: { name?: string } } | undefined)
				?.json_schema?.name !== "law_citizen_metadata",
	);

function summaries() {
	const db = new Database(dbPath, { readonly: true });
	const rows = db
		.query(
			"SELECT block_id, summary, model, prompt_version, generated_at != '' AS dated FROM citizen_article_summaries ORDER BY block_id",
		)
		.all() as Record<string, unknown>[];
	db.close();
	return rows;
}

describe("generate-citizen-tags.ts (daily cron) per-article summaries", () => {
	test("uses the shared request, only for articles, and stores traceability", async () => {
		expect(await runCron()).toBe(0);

		// a3 is a placeholder and "pr" a preamble: never sent.
		const sent = articleBodies();
		expect(sent).toHaveLength(2);
		const byUser = new Map(
			sent.map((b) => [
				(b.messages as { content: string }[])[1]?.content ?? "",
				b,
			]),
		);
		const cases: Array<[string, string]> = [
			["Artículo 1", LONG_ARTICLE],
			["Artículo 2", SHORT_ARTICLE],
		];
		for (const [title, text] of cases) {
			const expected = articleSummaryRequestBody(
				{ norm_title: "Ley de prueba", block_title: title, current_text: text },
				"openai/gpt-6-luna",
				{},
			);
			const user = (expected.messages as { content: string }[])[1]?.content;
			expect(user).toContain(text);
			expect(byUser.get(user ?? "")).toEqual(expected);
		}
		// The law-level call carries the same ZDR routing.
		const law = bodies().find((b) => !articleBodies().includes(b));
		expect(law?.provider).toEqual({
			zdr: true,
			data_collection: "deny",
			ignore: ["siliconflow"],
		});

		expect(summaries()).toEqual([
			{
				block_id: "a1",
				summary: expect.any(String),
				model: "openai/gpt-6-luna",
				prompt_version: "v10",
				dated: 1,
			},
			{
				block_id: "a2",
				summary: expect.any(String),
				model: "openai/gpt-6-luna",
				prompt_version: "v10",
				dated: 1,
			},
		]);
	});

	test("existing article summaries survive, even with the cap exhausted or --force", async () => {
		const db = new Database(dbPath);
		db.run(
			"INSERT INTO citizen_article_summaries (norm_id, block_id, summary, model) VALUES ('N', 'a2', ?, 'qwen/qwen3.8-27b')",
			[OLD_SUMMARY],
		);
		db.run(
			"INSERT INTO citizen_tags (norm_id, block_id, tag) VALUES ('N', 'a2', 'etiqueta previa'), ('N', '', 'etiqueta de ley vieja')",
		);
		db.close();

		// Cap exhausted: the law is summarized, no article request is made.
		expect(await runCron([], { ARTICLE_SUMMARIES_MAX_PER_RUN: "0" })).toBe(0);
		expect(articleBodies()).toHaveLength(0);
		expect(summaries()).toEqual([
			{
				block_id: "a2",
				summary: OLD_SUMMARY,
				model: "qwen/qwen3.8-27b",
				prompt_version: "",
				dated: 0,
			},
		]);

		// --force: the law is redone; a2 keeps its summary and is not re-sent,
		// only the missing a1 is generated.
		expect(await runCron(["--force"])).toBe(0);
		const sent = articleBodies();
		expect(sent).toHaveLength(1);
		expect((sent[0]?.messages as { content: string }[])[1]?.content).toContain(
			LONG_ARTICLE,
		);
		const rows = summaries();
		expect(rows.find((r) => r.block_id === "a2")?.summary).toBe(OLD_SUMMARY);
		expect(rows.map((r) => r.block_id)).toEqual(["a1", "a2"]);

		const check = new Database(dbPath, { readonly: true });
		const tags = check
			.query("SELECT block_id, tag FROM citizen_tags ORDER BY block_id, tag")
			.all();
		check.close();
		// Article tags kept; the law-level tags were replaced.
		expect(tags).toContainEqual({ block_id: "a2", tag: "etiqueta previa" });
		expect(tags).not.toContainEqual({
			block_id: "",
			tag: "etiqueta de ley vieja",
		});
		expect(tags).toContainEqual({ block_id: "", tag: "plazos" });
	});

	test("exits 1 when the API refuses every article request (e.g. 402)", async () => {
		writeMock(402);
		expect(await runCron()).toBe(1);
		expect(summaries()).toEqual([]);
	});
});
