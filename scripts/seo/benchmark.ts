#!/usr/bin/env bun
// Benchmark competing planning models on the SAME snapshot. The real outcome
// (traffic) takes weeks, so here we score PLAN QUALITY to decide which model
// drives planning in production. See .goals/seo/EVAL.md for the rubric.
//
//   MODELS="nan:qwen3.6,openrouter:x-ai/grok-4.5,openrouter:deepseek/deepseek-v4-flash" \
//     bun run scripts/seo/benchmark.ts
//
// Gates (eliminatory): valid schema + PLAYBOOK path compliance.
// Judge (Claude, fixed): specificity, data-grounding, prioritisation (0–5),
// risk (0..-5). Cost + latency break ties.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	chat,
	DATA_DIR,
	extractJson,
	type GscSnapshot,
	type Plan,
	pathViolations,
	today,
	type UmamiSnapshot,
} from "./lib.ts";
import { type PlanResult, plan } from "./plan.ts";

const MODELS = (
	process.env.MODELS ?? "nan:qwen3.6,openrouter:deepseek/deepseek-v4-flash"
)
	.split(",")
	.map((m) => m.trim())
	.filter(Boolean);
// A fixed, capable judge so no candidate is favoured. Override via JUDGE_MODEL.
const JUDGE_MODEL =
	process.env.JUDGE_MODEL ?? "openrouter:anthropic/claude-sonnet-5";

interface Scores {
	specificity: number;
	dataGrounding: number;
	prioritization: number;
	risk: number;
	comment: string;
}
interface Scored {
	model: string;
	ok: boolean;
	reason: string;
	meta?: PlanResult["meta"];
	scores?: Scores;
	total: number;
}

function schemaOk(p: Plan): string | null {
	if (!Array.isArray(p.actions) || p.actions.length === 0) return "no actions";
	for (const a of p.actions) {
		if (
			!a.type ||
			!a.change ||
			!Array.isArray(a.files) ||
			a.files.length === 0
		) {
			return `action ${a.id ?? "?"} missing type/change/files`;
		}
	}
	return null;
}

async function judge(p: Plan, gsc: GscSnapshot): Promise<Scores> {
	const rubric = readFileSync(
		join(DATA_DIR, "..", "..", ".goals", "seo", "EVAL.md"),
		"utf8",
	);
	const messages = [
		{
			role: "system" as const,
			content:
				"You are a neutral SEO reviewer scoring an action plan for leyabierta.es. " +
				"Score strictly from the plan and the data. Output ONLY JSON: " +
				'{ "specificity": 0-5, "dataGrounding": 0-5, "prioritization": 0-5, "risk": 0..-5, "comment": "one line" }. ' +
				"specificity = concrete file+change vs vague. dataGrounding = each action cites a real signal from the snapshot. " +
				"prioritization = attacks striking-distance / low-CTR before speculative work. " +
				"risk = 0 if safe, down to -5 for aggressive changes lacking requiresHumanReview.\n\n" +
				rubric,
		},
		{
			role: "user" as const,
			content: `SNAPSHOT (trimmed):\n${JSON.stringify(
				{
					totals: gsc.totals,
					strikingDistance: gsc.strikingDistance.slice(0, 10),
					lowCtrQueries: gsc.lowCtrQueries.slice(0, 10),
					risingQueries: gsc.risingQueries.slice(0, 10),
					zeroClickPages: gsc.zeroClickPages.slice(0, 10),
				},
				null,
				1,
			)}\n\nPLAN:\n${JSON.stringify(p, null, 1)}\n\nScore now. JSON only.`,
		},
	];
	const res = await chat(JUDGE_MODEL, messages, {
		temperature: 0,
		maxTokens: 700,
		jsonObject: true,
	});
	const s = extractJson(res.content) as Scores;
	return {
		specificity: Number(s.specificity) || 0,
		dataGrounding: Number(s.dataGrounding) || 0,
		prioritization: Number(s.prioritization) || 0,
		risk: Number(s.risk) || 0,
		comment: s.comment ?? "",
	};
}

async function scoreModel(
	model: string,
	gsc: GscSnapshot,
	umami: UmamiSnapshot,
	iteration: number,
): Promise<Scored> {
	let result: PlanResult;
	try {
		result = await plan(model, gsc, umami, iteration);
	} catch (e) {
		return {
			model,
			ok: false,
			reason: `plan failed: ${e instanceof Error ? e.message : e}`,
			total: 0,
		};
	}
	const p = result.plan;

	// Persist the raw plan for auditing.
	const safe = model.replace(/[^a-z0-9]+/gi, "-");
	writeFileSync(
		join(DATA_DIR, `plan-${safe}-${today()}.json`),
		JSON.stringify(p, null, 2),
	);

	const schemaErr = schemaOk(p);
	if (schemaErr)
		return {
			model,
			ok: false,
			reason: `schema: ${schemaErr}`,
			meta: result.meta,
			total: 0,
		};

	const violations = pathViolations(p.actions.flatMap((a) => a.files));
	if (violations.length > 0) {
		return {
			model,
			ok: false,
			reason: `PLAYBOOK: ${violations.join("; ")}`,
			meta: result.meta,
			total: 0,
		};
	}

	const scores = await judge(p, gsc);
	const total =
		scores.specificity +
		scores.dataGrounding +
		scores.prioritization +
		scores.risk;
	return {
		model,
		ok: true,
		reason: "passed gates",
		meta: result.meta,
		scores,
		total,
	};
}

function loadSnapshots() {
	const gscPath = join(DATA_DIR, "gsc-latest.json");
	const umamiPath = join(DATA_DIR, "umami-latest.json");
	if (!existsSync(gscPath) || !existsSync(umamiPath)) {
		throw new Error(
			"missing snapshots — run pull-gsc.ts and pull-umami.ts first",
		);
	}
	return {
		gsc: JSON.parse(readFileSync(gscPath, "utf8")) as GscSnapshot,
		umami: JSON.parse(readFileSync(umamiPath, "utf8")) as UmamiSnapshot,
	};
}

async function main() {
	const iteration = Number(process.env.SEO_ITERATION ?? 0);
	const { gsc, umami } = loadSnapshots();
	console.log(
		`Benchmarking ${MODELS.length} models on ${gsc.snapshotDate}, judge=${JUDGE_MODEL}\n`,
	);

	// Score sequentially to keep output readable and rate limits happy.
	const results: Scored[] = [];
	for (const m of MODELS) {
		process.stdout.write(`  ${m} … `);
		const r = await scoreModel(m, gsc, umami, iteration);
		console.log(
			r.ok
				? `total ${r.total} (${r.meta?.latencyMs}ms)`
				: `GATE FAIL — ${r.reason}`,
		);
		results.push(r);
	}

	results.sort(
		(a, b) =>
			b.total - a.total ||
			(a.meta?.completionTokens ?? 1e9) - (b.meta?.completionTokens ?? 1e9) ||
			(a.meta?.latencyMs ?? 1e9) - (b.meta?.latencyMs ?? 1e9),
	);

	const lines = [
		`# SEO plan benchmark — ${today()}`,
		"",
		`Snapshot: ${gsc.snapshotDate} · judge: ${JUDGE_MODEL}`,
		"",
		"| # | model | total | spec | data | prio | risk | tok | ms | note |",
		"|---|-------|------:|-----:|-----:|-----:|-----:|----:|---:|------|",
		...results.map((r, i) => {
			const s = r.scores;
			const tok = r.meta ? r.meta.promptTokens + r.meta.completionTokens : 0;
			return `| ${i + 1} | ${r.model} | ${r.ok ? r.total : "—"} | ${s?.specificity ?? "—"} | ${s?.dataGrounding ?? "—"} | ${s?.prioritization ?? "—"} | ${s?.risk ?? "—"} | ${tok} | ${r.meta?.latencyMs ?? "—"} | ${r.ok ? (s?.comment ?? "") : r.reason} |`;
		}),
		"",
		`Winner: **${results[0]?.ok ? results[0].model : "none passed gates"}**`,
	];
	const out = join(DATA_DIR, `benchmark-${today()}.md`);
	writeFileSync(out, lines.join("\n"));
	console.log(
		`\n✓ ${out}\nWinner: ${results[0]?.ok ? results[0].model : "none passed gates"}`,
	);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
