import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { CitizenSummaryService } from "../services/citizen-summary.ts";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENROUTER_API_KEY;
let calls = 0;

function stubLlm(content: string) {
	globalThis.fetch = (async () => {
		calls++;
		return new Response(
			JSON.stringify({
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 700, completion_tokens: 20, cost: 0.0001 },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
}

const ARTICLE = "Texto del artículo con suficiente longitud. ".repeat(5);

describe("CitizenSummaryService lazy generation cost guard", () => {
	let db: Database;

	beforeEach(() => {
		calls = 0;
		process.env.OPENROUTER_API_KEY = "test-key";
		db = new Database(":memory:");
		createSchema(db);
		db.run(
			"INSERT INTO norms (id, title, country, rank, published_at, status) VALUES ('N', 'Ley', 'es', 'ley', '2026-01-01', 'vigente')",
		);
		db.run(
			"INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', 'a1', 'precepto', 'Artículo 1', 1, ''), ('N', 'a2', 'precepto', 'Artículo 2', 2, '')",
		);
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		if (realKey === undefined)
			Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
		else process.env.OPENROUTER_API_KEY = realKey;
		db.close();
	});

	test("an article that yields an empty summary is not re-generated on every request", async () => {
		stubLlm('{"citizen_tags":[],"citizen_summary":""}');
		const svc = new CitizenSummaryService(db);
		for (let i = 0; i < 5; i++) {
			await svc.getOrGenerate("N", "a1", "Ley", "Artículo 1", ARTICLE);
		}
		expect(calls).toBe(1);
	});

	test("a non-empty summary is cached in the DB and served without new calls", async () => {
		stubLlm(
			'{"citizen_tags":["plazos"],"citizen_summary":"Tienes derecho a reclamar en un plazo de un mes."}',
		);
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
		expect(first?.citizen_summary).toContain("plazo");
		expect(second?.citizen_summary).toBe(first?.citizen_summary);
		expect(calls).toBe(1);
	});
});
