/**
 * End to end: runs the daily cron script (generate-citizen-tags.ts) against a
 * temporary DB with fetch mocked by a preload, and checks that per-article
 * summaries go through the shared generator: same request as the lazy and RAG
 * paths, whole article, traceability columns written.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

let dir: string;
let dbPath: string;
let bodiesPath: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "citizen-tags-"));
	dbPath = join(dir, "test.db");
	bodiesPath = join(dir, "bodies.jsonl");
	const db = new Database(dbPath);
	createSchema(db);
	db.run(
		"INSERT INTO norms (id, title, country, rank, published_at, status, citizen_summary) VALUES ('N', 'Ley de prueba', 'es', 'ley', '2026-09-01', 'vigente', '')",
	);
	const insert = db.prepare(
		"INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', ?, 'precepto', ?, ?, ?)",
	);
	insert.run("a1", "Artículo 1", 1, LONG_ARTICLE);
	insert.run("a2", "Artículo 2", 2, SHORT_ARTICLE);
	insert.run("a3", "Artículo 3", 3, "Artículo 3.\n(Derogado)");
	db.close();

	writeFileSync(
		join(dir, "mock-fetch.ts"),
		`import { appendFileSync } from "node:fs";
globalThis.fetch = (async (_url, init) => {
	const body = JSON.parse(String(init.body));
	appendFileSync(${JSON.stringify(bodiesPath)}, JSON.stringify(body) + "\\n");
	const law = body.response_format?.json_schema?.name === "law_citizen_metadata";
	const content = law
		? JSON.stringify({ citizen_tags: ["trámites", "plazos"], citizen_summary: "Regula los plazos de las solicitudes." })
		: JSON.stringify({ articles: [{ article_id: "ARTÍCULO_1", citizen_summary: "La administración resuelve las solicitudes en un plazo de tres meses desde su presentación.", citizen_tags: ["plazos", "solicitudes", "administración"] }] });
	return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0.0001 } }), { status: 200 });
}) as typeof fetch;
`,
	);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("generate-citizen-tags.ts (daily cron) per-article summaries", () => {
	test("uses the shared request and stores traceability", async () => {
		const proc = Bun.spawn(
			[
				"bun",
				"--preload",
				join(dir, "mock-fetch.ts"),
				SCRIPT,
				"--norm-id",
				"N",
			],
			{
				env: {
					...process.env,
					DB_PATH: dbPath,
					OPENROUTER_API_KEY: "test-key",
					OPENROUTER_BACKOFF_MS: "0",
					ARTICLE_SUMMARIES_MODEL: "",
					OPENROUTER_ZDR: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const code = await proc.exited;
		expect(code).toBe(0);

		const bodies = readFileSync(bodiesPath, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const articleBodies = bodies.filter(
			(b) => b.response_format?.json_schema?.name !== "law_citizen_metadata",
		);
		// a3 is a placeholder: never sent.
		expect(articleBodies).toHaveLength(2);
		const sent = new Map(
			articleBodies.map((b) => [b.messages[1].content as string, b]),
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
			expect(sent.get(user ?? "")).toEqual(expected);
		}

		const db = new Database(dbPath, { readonly: true });
		const rows = db
			.query(
				"SELECT block_id, model, prompt_version, generated_at != '' AS dated FROM citizen_article_summaries ORDER BY block_id",
			)
			.all();
		db.close();
		expect(rows).toEqual([
			{
				block_id: "a1",
				model: "openai/gpt-6-luna",
				prompt_version: "v10",
				dated: 1,
			},
			{
				block_id: "a2",
				model: "openai/gpt-6-luna",
				prompt_version: "v10",
				dated: 1,
			},
		]);
	});
});
