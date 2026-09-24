import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ARTICLE_SUMMARY_PROMPT_VERSION,
	articleSummaryRequestBody,
	createSchema,
} from "@leyabierta/pipeline";
import { CitizenSummaryService } from "../services/citizen-summary.ts";
import { callOpenRouter } from "../services/openrouter.ts";
import { generateMissingSummaries } from "../services/rag/synthesis.ts";

const realFetch = globalThis.fetch;
const saved = {
	OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
	OPENROUTER_BACKOFF_MS: process.env.OPENROUTER_BACKOFF_MS,
	ARTICLE_SUMMARIES_MODEL: process.env.ARTICLE_SUMMARIES_MODEL,
};
let bodies: Record<string, unknown>[] = [];

function stubLlm(content: string) {
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return new Response(
			JSON.stringify({
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 700, completion_tokens: 20, cost: 0.0001 },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
}

const reply = (
	summary: string,
	tags = ["plazos", "reclamaciones", "trámites"],
) =>
	JSON.stringify({
		articles: [
			{
				article_id: "ARTÍCULO_1",
				citizen_summary: summary,
				citizen_tags: tags,
			},
		],
	});

const GOOD =
	"El ciudadano puede reclamar en un plazo de un mes desde la notificación de la resolución.";
const ARTICLE = `Artículo 2. Reclamaciones.\n${"El interesado podrá reclamar en el plazo de un mes desde la notificación. ".repeat(3)}`;

/** Resolves once the fire-and-forget work has had time to run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("CitizenSummaryService (lazy route)", () => {
	let db: Database;

	beforeEach(() => {
		bodies = [];
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_BACKOFF_MS = "0";
		Reflect.deleteProperty(process.env, "ARTICLE_SUMMARIES_MODEL");
		db = new Database(":memory:");
		createSchema(db);
		db.run(
			"INSERT INTO norms (id, title, country, rank, published_at, status) VALUES ('N', 'Ley', 'es', 'ley', '2026-01-01', 'vigente')",
		);
		db.run(
			`INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', 'a1', 'precepto', 'Artículo 1', 1, ''), ('N', 'a2', 'precepto', 'Artículo 2', 2, '${ARTICLE}')`,
		);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		for (const [k, v] of Object.entries(saved))
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		db.close();
	});

	test("an article whose summary fails validation is not re-generated on every request", async () => {
		stubLlm(reply("Tienes derecho a reclamar en un plazo de un mes."));
		const svc = new CitizenSummaryService(db);
		for (let i = 0; i < 5; i++) {
			await svc.getOrGenerate("N", "a2", "Ley", "Artículo 2", ARTICLE);
		}
		expect(bodies).toHaveLength(1);
		expect(
			db.query("SELECT count(*) AS n FROM citizen_article_summaries").get(),
		).toEqual({ n: 0 });
	});

	test("a valid summary is stored with model, prompt version and date, and served from the DB", async () => {
		stubLlm(reply(GOOD));
		const svc = new CitizenSummaryService(db);
		const first = await svc.getOrGenerate(
			"N",
			"a2",
			"Ley",
			"Artículo 2",
			ARTICLE,
		);
		const second = await svc.getOrGenerate(
			"N",
			"a2",
			"Ley",
			"Artículo 2",
			ARTICLE,
		);
		expect(first?.citizen_summary).toBe(GOOD);
		expect(second).toEqual(first);
		expect(bodies).toHaveLength(1);
		const row = db
			.query(
				"SELECT model, prompt_version, generated_at FROM citizen_article_summaries",
			)
			.get() as Record<string, string>;
		expect(row.model).toBe("openai/gpt-6-luna");
		expect(row.prompt_version).toBe(ARTICLE_SUMMARY_PROMPT_VERSION);
		expect(row.generated_at).not.toBe("");
	});

	test("the request is the shared one: v10 prompt, whole article, luna minimal, ZDR", async () => {
		stubLlm(reply(GOOD));
		const svc = new CitizenSummaryService(db);
		await svc.getOrGenerate("N", "a2", "Ley", "Artículo 2", ARTICLE);
		expect(bodies[0]).toEqual(
			articleSummaryRequestBody(
				{ norm_title: "Ley", block_title: "Artículo 2", current_text: ARTICLE },
				"openai/gpt-6-luna",
			),
		);
	});

	test("a summary in another script is never stored or served", async () => {
		stubLlm(reply(`${GOOD}军事`));
		const svc = new CitizenSummaryService(db);
		const res = await svc.getOrGenerate(
			"N",
			"a2",
			"Ley",
			"Artículo 2",
			ARTICLE,
		);
		expect(res).toBeNull();
		expect(
			db.query("SELECT count(*) AS n FROM citizen_article_summaries").get(),
		).toEqual({ n: 0 });
		expect(db.query("SELECT count(*) AS n FROM citizen_tags").get()).toEqual({
			n: 0,
		});
	});

	test("an existing empty row is respected: no paid call", async () => {
		db.run(
			"INSERT INTO citizen_article_summaries (norm_id, block_id, summary) VALUES ('N', 'a2', '')",
		);
		stubLlm(reply(GOOD));
		const svc = new CitizenSummaryService(db);
		expect(
			await svc.getOrGenerate("N", "a2", "Ley", "Artículo 2", ARTICLE),
		).toBeNull();
		expect(bodies).toHaveLength(0);
	});

	test("placeholder articles are not sent", async () => {
		stubLlm(reply(GOOD));
		const svc = new CitizenSummaryService(db);
		await svc.getOrGenerate(
			"N",
			"a1",
			"Ley",
			"Artículo 1",
			"Artículo 1.\n(Derogado)                                                   ",
		);
		expect(bodies).toHaveLength(0);
	});
});

describe("RAG background fill (generateMissingSummaries)", () => {
	let db: Database;

	beforeEach(() => {
		bodies = [];
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_BACKOFF_MS = "0";
		db = new Database(":memory:");
		createSchema(db);
		db.run(
			"INSERT INTO norms (id, title, country, rank, published_at, status) VALUES ('N', 'Ley', 'es', 'ley', '2026-01-01', 'vigente')",
		);
		db.run(
			`INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', 'a2', 'precepto', 'Artículo 2', 2, '${ARTICLE}')`,
		);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		for (const [k, v] of Object.entries(saved))
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		db.close();
	});

	test("summarizes the cited article's whole text from the DB with the shared request", async () => {
		stubLlm(reply(GOOD));
		generateMissingSummaries({
			citations: [
				{
					normId: "N",
					normTitle: "Ley",
					articleTitle: "Artículo 2",
					anchor: "articulo-2",
					blockId: "a2",
					verified: true,
				},
			],
			citizenSummaries: new CitizenSummaryService(db),
		});
		await settle();
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toEqual(
			articleSummaryRequestBody(
				{ norm_title: "Ley", block_title: "Artículo 2", current_text: ARTICLE },
				"openai/gpt-6-luna",
			),
		);
		expect(
			db.query("SELECT summary, model FROM citizen_article_summaries").get(),
		).toEqual({ summary: GOOD, model: "openai/gpt-6-luna" });
	});

	test("approximate citations (no block id) and already summarized ones are skipped", async () => {
		stubLlm(reply(GOOD));
		generateMissingSummaries({
			citations: [
				{
					normId: "N",
					normTitle: "Ley",
					articleTitle: "Art. 2",
					anchor: "a",
					verified: false,
				},
				{
					normId: "N",
					normTitle: "Ley",
					articleTitle: "Artículo 2",
					anchor: "a",
					blockId: "a2",
					citizenSummary: "ya existe",
					verified: true,
				},
			],
			citizenSummaries: new CitizenSummaryService(db),
		});
		await settle();
		expect(bodies).toHaveLength(0);
	});
});

describe("request parity with the API's OpenRouter client", () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("callOpenRouter sends the same body for the same settings", async () => {
		stubLlm(reply(GOOD));
		bodies = [];
		const article = {
			norm_title: "Ley",
			block_title: "Artículo 2",
			current_text: ARTICLE,
		};
		const shared = articleSummaryRequestBody(article, "openai/gpt-6-luna");
		const format = shared.response_format as {
			json_schema: { name: string; schema: Record<string, unknown> };
		};
		await callOpenRouter("k", {
			model: "openai/gpt-6-luna",
			messages: shared.messages as never,
			temperature: shared.temperature as number,
			maxTokens: shared.max_tokens as number,
			reasoning: { effort: "minimal" },
			jsonSchema: format.json_schema,
		});
		expect(bodies[0]).toEqual(shared);
	});
});
