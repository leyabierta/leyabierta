import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
	ARTICLE_MAX_INPUT_CHARS,
	articleHasSubstance,
	articleSummariesModel,
	articleSummaryRequestBody,
	generateArticleSummary,
	maxSummaryChars,
	storeArticleSummary,
	validateArticleSummary,
} from "../src/ai/article-summary.ts";
import {
	ARTICLE_SUMMARY_PROMPT_VERSION,
	SYSTEM_PROMPT,
} from "../src/ai/article-summary-prompt.ts";
import { createSchema } from "../src/db/schema.ts";

const ARTICLE = {
	norm_title: "Ley de prueba",
	block_title: "Artículo 1",
	current_text: `Artículo 1. Objeto.\n${"El ciudadano podrá presentar la solicitud en el plazo de un mes. ".repeat(3)}`,
};
const GOOD_SUMMARY =
	"El ciudadano puede presentar la solicitud en el plazo de un mes desde la notificación.";
const GOOD_TAGS = ["solicitudes", "plazos", "trámites"];

function reply(summary: string, tags: string[]) {
	return JSON.stringify({
		articles: [
			{
				article_id: "ARTÍCULO_1",
				citizen_summary: summary,
				citizen_tags: tags,
			},
		],
	});
}

/** fetch stub: answers the queued responses in order, records every body. */
function stubFetch(responses: Array<() => Response>) {
	const bodies: Record<string, unknown>[] = [];
	let i = 0;
	const fn = (async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		const next = responses[Math.min(i++, responses.length - 1)];
		return next ? next() : new Response("{}", { status: 500 });
	}) as unknown as typeof fetch;
	return { fn, bodies };
}

const ok = (content: string) => () =>
	new Response(
		JSON.stringify({
			choices: [{ message: { content } }],
			usage: { cost: 0.0002 },
		}),
		{ status: 200 },
	);
const env = { OPENROUTER_BACKOFF_MS: "0" };

describe("articleSummaryRequestBody", () => {
	test("sends the v10 prompt and the whole article, no truncation", () => {
		const long = {
			...ARTICLE,
			current_text: `Artículo 9.\n${"x".repeat(20_000)}FIN`,
		};
		const body = articleSummaryRequestBody(long, "openai/gpt-6-luna", env);
		const messages = body.messages as { role: string; content: string }[];
		expect(messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
		expect(messages[1]?.content).toContain(long.current_text);
		expect(messages[1]?.content).toContain("LEY: Ley de prueba");
	});

	test("reasoning: minimal for openai/*, off for qwen/*, none otherwise", () => {
		expect(
			articleSummaryRequestBody(ARTICLE, "openai/gpt-6-luna", env).reasoning,
		).toEqual({ effort: "minimal" });
		expect(
			articleSummaryRequestBody(ARTICLE, "qwen/qwen3.8-27b", env).reasoning,
		).toEqual({ enabled: false });
		expect(
			"reasoning" in
				articleSummaryRequestBody(ARTICLE, "google/gemini-2.5-flash-lite", env),
		).toBe(false);
	});

	test("ZDR provider preferences by default; none only with OPENROUTER_ZDR=false", () => {
		expect(articleSummaryRequestBody(ARTICLE, "m", env).provider).toEqual({
			zdr: true,
			data_collection: "deny",
			ignore: ["siliconflow"],
		});
		expect(
			"provider" in
				articleSummaryRequestBody(ARTICLE, "m", { OPENROUTER_ZDR: "false" }),
		).toBe(false);
	});

	test("strict JSON schema output", () => {
		const body = articleSummaryRequestBody(ARTICLE, "m", env);
		expect(body.response_format).toMatchObject({
			type: "json_schema",
			json_schema: { name: "citizen_metadata_batch", strict: true },
		});
	});

	test("model from ARTICLE_SUMMARIES_MODEL, default openai/gpt-6-luna", () => {
		expect(articleSummariesModel({})).toBe("openai/gpt-6-luna");
		expect(articleSummariesModel({ ARTICLE_SUMMARIES_MODEL: " x/y " })).toBe(
			"x/y",
		);
	});
});

describe("validateArticleSummary", () => {
	test("length cap scales with the article", () => {
		const s = "a".repeat(350);
		expect(validateArticleSummary(s, GOOD_TAGS, 500)).toEqual({
			ok: false,
			reason: "too_long",
		});
		expect(validateArticleSummary(s, GOOD_TAGS, 1500).ok).toBe(true);
		expect(maxSummaryChars(6000)).toBe(600);
	});

	test("rejects second person, bad tag counts and other scripts", () => {
		expect(
			validateArticleSummary(
				"Tienes derecho a presentar la solicitud en un mes.",
				GOOD_TAGS,
			),
		).toEqual({ ok: false, reason: "second_person" });
		expect(validateArticleSummary(GOOD_SUMMARY, ["uno"])).toEqual({
			ok: false,
			reason: "bad_tag_count",
		});
		expect(validateArticleSummary(`${GOOD_SUMMARY}军事`, GOOD_TAGS)).toEqual({
			ok: false,
			reason: "foreign_script",
		});
	});

	test("dedupes tags case-insensitively", () => {
		const v = validateArticleSummary(GOOD_SUMMARY, [
			"Plazos",
			"plazos",
			"solicitudes",
			"trámites",
		]);
		expect(v).toEqual({
			ok: true,
			summary: GOOD_SUMMARY,
			tags: ["Plazos", "solicitudes", "trámites"],
		});
	});
});

describe("articleHasSubstance", () => {
	test("placeholders and bare headings have none", () => {
		expect(articleHasSubstance("Artículo 3.\n(Derogado)")).toBe(false);
		expect(articleHasSubstance("CAPÍTULO I\nDisposiciones generales")).toBe(
			false,
		);
		expect(articleHasSubstance(ARTICLE.current_text)).toBe(true);
	});
});

describe("generateArticleSummary", () => {
	test("retries an upstream error reported inside an HTTP 200, then succeeds", async () => {
		const { fn, bodies } = stubFetch([
			() =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "" } }],
						error: { code: 429, message: "rate-limited upstream" },
					}),
					{ status: 200 },
				),
			ok(reply(GOOD_SUMMARY, GOOD_TAGS)),
		]);
		const r = await generateArticleSummary({
			apiKey: "k",
			article: ARTICLE,
			model: "openai/gpt-6-luna",
			fetchFn: fn,
			env,
		});
		expect(r).toEqual({
			ok: true,
			summary: GOOD_SUMMARY,
			tags: GOOD_TAGS,
			model: "openai/gpt-6-luna",
			promptVersion: ARTICLE_SUMMARY_PROMPT_VERSION,
			cost: 0.0002,
		});
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toEqual(bodies[1] as Record<string, unknown>);
		expect(bodies[0]).toEqual(
			articleSummaryRequestBody(ARTICLE, "openai/gpt-6-luna", env),
		);
	});

	test("gives up after maxAttempts with the last reason", async () => {
		const { fn, bodies } = stubFetch([
			() => new Response("busy", { status: 503 }),
		]);
		const r = await generateArticleSummary({
			apiKey: "k",
			article: ARTICLE,
			fetchFn: fn,
			env,
		});
		expect(r).toEqual({ ok: false, reason: "http_503" });
		expect(bodies).toHaveLength(3);
	});

	test("a 4xx (e.g. no ZDR endpoint) is not retried", async () => {
		const { fn, bodies } = stubFetch([
			() => new Response("no endpoints", { status: 404 }),
		]);
		const r = await generateArticleSummary({
			apiKey: "k",
			article: ARTICLE,
			fetchFn: fn,
			env,
		});
		expect(r).toMatchObject({ ok: false, reason: "http_404" });
		expect(bodies).toHaveLength(1);
	});

	test("an invalid summary is returned as a failure, not retried", async () => {
		const { fn, bodies } = stubFetch([
			ok(reply("Puedes presentar la solicitud en un mes.", GOOD_TAGS)),
		]);
		const r = await generateArticleSummary({
			apiKey: "k",
			article: ARTICLE,
			fetchFn: fn,
			env,
		});
		expect(r).toEqual({ ok: false, reason: "second_person" });
		expect(bodies).toHaveLength(1);
	});

	test("an article longer than the input cap is skipped without a call", async () => {
		const { fn, bodies } = stubFetch([ok(reply(GOOD_SUMMARY, GOOD_TAGS))]);
		const r = await generateArticleSummary({
			apiKey: "k",
			article: {
				...ARTICLE,
				current_text: "x".repeat(ARTICLE_MAX_INPUT_CHARS + 1),
			},
			fetchFn: fn,
			env,
		});
		expect(r).toEqual({ ok: false, reason: "article_too_long" });
		expect(bodies).toHaveLength(0);
	});
});

describe("storeArticleSummary", () => {
	let db: Database;
	beforeEach(() => {
		db = new Database(":memory:");
		createSchema(db);
		db.run(
			"INSERT INTO norms (id, title, country, rank, published_at, status) VALUES ('N', 'Ley', 'es', 'ley', '2026-01-01', 'vigente')",
		);
		db.run(
			"INSERT INTO blocks (norm_id, block_id, block_type, title, position, current_text) VALUES ('N', 'a1', 'precepto', 'Artículo 1', 1, 'x')",
		);
	});
	const result = {
		summary: GOOD_SUMMARY,
		tags: GOOD_TAGS,
		model: "openai/gpt-6-luna",
		promptVersion: ARTICLE_SUMMARY_PROMPT_VERSION,
	};

	test("stores summary, tags, model, prompt version and date", () => {
		expect(storeArticleSummary(db, "N", "a1", result)).toBe(true);
		const row = db
			.query(
				"SELECT summary, model, prompt_version, generated_at FROM citizen_article_summaries",
			)
			.get() as Record<string, string>;
		expect(row.summary).toBe(GOOD_SUMMARY);
		expect(row.model).toBe("openai/gpt-6-luna");
		expect(row.prompt_version).toBe("v10");
		expect(row.generated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		expect(db.query("SELECT count(*) AS n FROM citizen_tags").get()).toEqual({
			n: 3,
		});
	});

	test("never overwrites an existing summary, even an empty one", () => {
		db.run(
			"INSERT INTO citizen_article_summaries (norm_id, block_id, summary) VALUES ('N', 'a1', '')",
		);
		expect(storeArticleSummary(db, "N", "a1", result)).toBe(false);
		expect(
			db.query("SELECT summary FROM citizen_article_summaries").get(),
		).toEqual({ summary: "" });
		expect(db.query("SELECT count(*) AS n FROM citizen_tags").get()).toEqual({
			n: 0,
		});
	});

	test("keeps existing article tags", () => {
		db.run(
			"INSERT INTO citizen_tags (norm_id, block_id, tag) VALUES ('N', 'a1', 'previa')",
		);
		expect(storeArticleSummary(db, "N", "a1", result)).toBe(true);
		expect(db.query("SELECT tag FROM citizen_tags").all()).toEqual([
			{ tag: "previa" },
		]);
	});
});
