/**
 * Generate citizen fichas for a set of laws with several models.
 *
 * Pipeline per (model, law): extraction (law + previous wording → JSON with
 * verbatim quotes) → writing (extraction → ficha JSON) → mechanical checks
 * (quotes found in the source, numbers in the ficha found in the source).
 * Grading against the checklists is done separately by a judge that is not
 * one of the models under test.
 *
 * Public legislation only: requests carry no ZDR routing preference, so they
 * must never include a citizen's question.
 *
 *   bun run packages/eval/src/fichas/run.ts --models a,b --laws id1,id2 \
 *     --src DIR --out DIR [--budget 0.15] [--floor 0.40] [--concurrency 3]
 *
 * DIR (--src) holds src-<id>.md (fetch-law-text.ts) and prev-<id>.md
 * (previous wording of the modified articles, may be empty).
 */

import { parseArgs } from "node:util";
import {
	EXTRACTION_SYSTEM,
	extractionUser,
	FICHAS_PROMPT_VERSION,
	REVIEW_SYSTEM,
	reviewUser,
	WRITING_SYSTEM,
	writingUser,
} from "./prompts.ts";
import { checkFicha, renderFicha } from "./render.ts";

const OPENROUTER = "https://openrouter.ai/api/v1";

const { values } = parseArgs({
	options: {
		models: { type: "string" },
		laws: { type: "string" },
		src: { type: "string" },
		out: { type: "string" },
		budget: { type: "string", default: "0.15" },
		floor: { type: "string", default: "0.40" },
		concurrency: { type: "string", default: "3" },
		reasoning: { type: "string", default: "low" },
		// Only run the review stage on fichas already generated in this dir.
		"review-from": { type: "string" },
		// Reuse the extraction of fichas already generated in this dir.
		"extraction-from": { type: "string" },
		// Run the review stage after writing.
		review: { type: "boolean", default: false },
	},
});

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey || !values.models || !values.laws || !values.src || !values.out) {
	console.error(
		"usage: run.ts --models a,b --laws id1,id2 --src DIR --out DIR (OPENROUTER_API_KEY required)",
	);
	process.exit(1);
}
const models = values.models.split(",");
const laws = values.laws.split(",");
const budget = Number(values.budget);
const floor = Number(values.floor);

async function remainingCredit(): Promise<number> {
	const res = await fetch(`${OPENROUTER}/credits`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	const { data } = (await res.json()) as {
		data: { total_credits: number; total_usage: number };
	};
	return data.total_credits - data.total_usage;
}

let spent = 0;
let stopped = "";
const startCredit = await remainingCredit();
console.log(
	`credit ${startCredit.toFixed(3)} | budget ${budget} | floor ${floor}`,
);

/** Refuse a call once the run's budget or the account floor is reached. */
async function guard(): Promise<void> {
	if (stopped) throw new Error(stopped);
	if (spent >= budget) stopped = `budget reached (${spent.toFixed(4)})`;
	else if ((await remainingCredit()) < floor) stopped = "credit floor reached";
	if (stopped) throw new Error(stopped);
}

interface CallResult {
	content: string;
	cost: number;
	tokensIn: number;
	tokensOut: number;
	provider: string;
	ms: number;
}

async function chat(
	model: string,
	system: string,
	user: string,
): Promise<CallResult> {
	await guard();
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt) await Bun.sleep(5000 * attempt);
		const t0 = Date.now();
		const res = await fetch(`${OPENROUTER}/chat/completions`, {
			method: "POST",
			signal: AbortSignal.timeout(600_000),
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"HTTP-Referer": "https://leyabierta.es",
				"X-Title": "Ley Abierta (eval fichas)",
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				temperature: 0.2,
				max_tokens: 32000,
				reasoning: { effort: values.reasoning },
				response_format: { type: "json_object" },
				// Several providers serve the same weights at different prices;
				// fp4 builds are excluded so quantization does not skew the eval.
				provider: {
					sort: "price",
					quantizations: ["fp8", "fp16", "bf16", "fp32", "unknown"],
				},
			}),
		}).catch((e) => e as Error);
		if (res instanceof Error) {
			console.warn(`  ${model}: network ${res.message}`);
			continue;
		}
		const body = (await res.json().catch(() => null)) as {
			error?: { message?: string; code?: number };
			provider?: string;
			choices?: Array<{
				message?: { content?: string };
				finish_reason?: string;
			}>;
			usage?: {
				cost?: number;
				prompt_tokens?: number;
				completion_tokens?: number;
				completion_tokens_details?: { reasoning_tokens?: number };
			};
		} | null;
		const cost = body?.usage?.cost ?? 0;
		spent += cost;
		const content = body?.choices?.[0]?.message?.content ?? "";
		console.log(
			`  call ${model} via ${body?.provider ?? "?"}: in ${body?.usage?.prompt_tokens} out ${body?.usage?.completion_tokens} (reasoning ${body?.usage?.completion_tokens_details?.reasoning_tokens ?? "?"}) finish ${body?.choices?.[0]?.finish_reason} cost ${cost.toFixed(4)} ${((Date.now() - t0) / 1000).toFixed(0)}s`,
		);
		if (!res.ok || body?.error || !content.trim()) {
			console.warn(
				`  ${model}: ${res.status} ${body?.error?.message?.slice(0, 160) ?? "empty content"}`,
			);
			if (res.status === 401 || res.status === 402 || res.status === 404) break;
			continue;
		}
		return {
			content,
			cost,
			tokensIn: body?.usage?.prompt_tokens ?? 0,
			tokensOut: body?.usage?.completion_tokens ?? 0,
			provider: body?.provider ?? "",
			ms: Date.now() - t0,
		};
	}
	throw new Error(`${model}: no usable response`);
}

function parseJson(text: string): unknown {
	const cleaned = text
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/^```(?:json)?\s*|\s*```$/g, "")
		.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	return JSON.parse(cleaned.slice(start, end + 1));
}

async function runOne(model: string, lawId: string): Promise<void> {
	const slug = model.replace(/[/:]/g, "_");
	const outBase = `${values.out}/${lawId}__${slug}`;
	if (await Bun.file(`${outBase}.json`).exists()) {
		console.log(`skip ${lawId} ${model} (done)`);
		return;
	}
	const lawText = await Bun.file(`${values.src}/src-${lawId}.md`).text();
	const prevFile = Bun.file(`${values.src}/prev-${lawId}.md`);
	const previousWording = (await prevFile.exists())
		? await prevFile.text()
		: "";
	const meta = JSON.parse(
		await Bun.file(`${values.src}/meta-${lawId}.json`).text(),
	) as { title: string; published_at: string };

	if (values["review-from"]) {
		const base = JSON.parse(
			await Bun.file(`${values["review-from"]}/${lawId}__${slug}.json`).text(),
		) as { extraction: unknown; ficha: unknown };
		const rv = await chat(
			model,
			REVIEW_SYSTEM,
			reviewUser({
				title: meta.title,
				lawText,
				previousWording,
				ficha: base.ficha,
			}),
		);
		const out = parseJson(rv.content) as {
			ficha: unknown;
			correcciones: unknown[];
		};
		const checks = checkFicha(
			base.extraction,
			out.ficha,
			`${lawText}\n${previousWording}`,
		);
		const { content: _c, ...call } = rv;
		await Bun.write(
			`${outBase}.json`,
			JSON.stringify(
				{
					law: lawId,
					model,
					stage: "review",
					reasoning: values.reasoning,
					generated_at: new Date().toISOString(),
					calls: [call],
					extraction: base.extraction,
					ficha: out.ficha,
					correcciones: out.correcciones,
					checks,
				},
				null,
				2,
			),
		);
		await Bun.write(`${outBase}.md`, renderFicha(meta.title, out.ficha));
		console.log(
			`ok review ${lawId} ${model} | ${(rv.ms / 1000).toFixed(0)}s | ${out.correcciones?.length ?? 0} correcciones | numbers not in source: ${checks.unsupportedNumbers.join(" ") || "-"}`,
		);
		return;
	}

	let ex: CallResult | null = null;
	let extraction: unknown;
	if (values["extraction-from"]) {
		extraction = (
			JSON.parse(
				await Bun.file(
					`${values["extraction-from"]}/${lawId}__${slug}.json`,
				).text(),
			) as { extraction: unknown }
		).extraction;
	} else {
		ex = await chat(
			model,
			EXTRACTION_SYSTEM,
			extractionUser({ title: meta.title, lawText, previousWording }),
		);
		extraction = parseJson(ex.content);
	}
	const wr = await chat(
		model,
		WRITING_SYSTEM,
		writingUser({
			title: meta.title,
			publishedAt: meta.published_at,
			extraction,
		}),
	);
	let ficha = parseJson(wr.content);
	let rv: CallResult | null = null;
	let correcciones: unknown[] | undefined;
	if (values.review) {
		rv = await chat(
			model,
			REVIEW_SYSTEM,
			reviewUser({ title: meta.title, lawText, previousWording, ficha }),
		);
		type Reviewed = { ficha?: unknown; correcciones?: unknown[] };
		let out: Reviewed | null = null;
		try {
			out = parseJson(rv.content) as Reviewed;
		} catch {}
		// A truncated or malformed review must not replace a good ficha.
		if ((out?.ficha as { titular?: string } | undefined)?.titular) {
			ficha = out?.ficha;
			correcciones = out?.correcciones;
		} else
			console.warn(`  ${lawId}: review unusable, keeping the written ficha`);
	}
	const checks = checkFicha(
		extraction,
		ficha,
		`${lawText}\n${previousWording}`,
	);
	const record = {
		law: lawId,
		model,
		prompt_version: FICHAS_PROMPT_VERSION,
		reasoning: values.reasoning,
		generated_at: new Date().toISOString(),
		calls: [ex, wr, rv]
			.filter((c): c is CallResult => c !== null)
			.map(({ content: _c, ...rest }) => rest),
		extraction,
		ficha,
		correcciones,
		checks,
	};
	await Bun.write(`${outBase}.json`, JSON.stringify(record, null, 2));
	await Bun.write(`${outBase}.md`, renderFicha(meta.title, ficha));
	console.log(
		`ok ${lawId} ${model} | ${(((ex?.ms ?? 0) + wr.ms + (rv?.ms ?? 0)) / 1000).toFixed(0)}s | quotes ${checks.quotesFound}/${checks.quotesTotal} | numbers not in source: ${checks.unsupportedNumbers.join(" ") || "-"}`,
	);
}

const jobs = laws.flatMap((law) => models.map((model) => ({ law, model })));
const failures: string[] = [];
const queue = [...jobs];
await Promise.all(
	Array.from({ length: Number(values.concurrency) }, async () => {
		for (let job = queue.shift(); job; job = queue.shift()) {
			try {
				await runOne(job.model, job.law);
			} catch (e) {
				failures.push(`${job.law} ${job.model}: ${(e as Error).message}`);
				console.warn(`FAIL ${job.law} ${job.model}: ${(e as Error).message}`);
			}
		}
	}),
);

const endCredit = await remainingCredit();
console.log(
	`\nspent (usage.cost) ${spent.toFixed(4)} | credit ${startCredit.toFixed(3)} → ${endCredit.toFixed(3)}`,
);
if (failures.length) console.log(`failures:\n  ${failures.join("\n  ")}`);
