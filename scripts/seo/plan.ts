#!/usr/bin/env bun
// The pluggable planning step. Given the GSC + Umami snapshots (plus STATE and
// recent PROGRESS), a model proposes a structured JSON action plan. This is pure
// inference so any model competes fairly — that's what benchmark.ts exploits.
//
//   MODEL=claude:sonnet bun run scripts/seo/plan.ts
//   MODEL=nan:deepseek-v4-flash bun run scripts/seo/plan.ts
//
// MODEL is "provider:model". Providers: claude (local `claude -p` CLI) and
// nan (api.nan.builders, key NAN_API_KEY / HERMES_API_KEY). No OpenRouter.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	chat,
	DATA_DIR,
	extractJson,
	GOALS_DIR,
	type GscSnapshot,
	type Plan,
	today,
	type UmamiSnapshot,
} from "./lib.ts";

export interface PlanResult {
	plan: Plan;
	meta: {
		model: string;
		latencyMs: number;
		promptTokens: number;
		completionTokens: number;
	};
}

// A concise, hand-maintained map of the editable SEO surface so the model
// proposes changes against real files and doesn't re-suggest things already
// shipped. Keep in sync with the codebase when the surface changes.
const SEO_SURFACE = `
Editable SEO surface (Astro static site → Cloudflare Pages):
- packages/web/src/layouts/Base.astro — <head>: title/description/canonical/OG/Twitter,
  JSON-LD Organization+WebSite. Accepts props: title, description, ogTitle,
  ogDescription, ogType, ogImage, canonicalUrl, noindex.
- packages/web/src/pages/leyes/[id].astro — law detail. ALREADY HAS: JSON-LD
  Legislation + BreadcrumbList; SEO description = abbrev · citizen summary ·
  estado · departamento; abbreviation aliases (e.g. "RD 769/87"); a build-time
  "Normas relacionadas" block linking siblings by shared materias. Frontmatter
  available per law: titulo, identificador, rango, estado, jurisdiccion,
  fecha_publicacion, ultima_actualizacion, departamento, materias[], notas[],
  referencias_anteriores[], referencias_posteriores[], reformas[], articulos.
- packages/web/src/pages/**.astro — static pages (index, cambios, sobre, etc.).
- packages/web/src/pages/sitemap.xml.ts — dynamic sitemap (priority/changefreq).
- Materia tag links currently point to /?materia=X (client-side search, weak for
  crawlers). No static /temas/[materia]/ hub pages exist yet.
`.trim();

function buildMessages(
	gsc: GscSnapshot,
	umami: UmamiSnapshot,
	iteration: number,
) {
	const playbook = readFileSync(join(GOALS_DIR, "PLAYBOOK.md"), "utf8");
	const evalDoc = readFileSync(join(GOALS_DIR, "EVAL.md"), "utf8");
	const statePath = join(DATA_DIR, "STATE.md");
	const progressPath = join(DATA_DIR, "PROGRESS.md");
	const state = existsSync(statePath)
		? readFileSync(statePath, "utf8")
		: "(no STATE yet — iteration 0)";
	const progress = existsSync(progressPath)
		? readFileSync(progressPath, "utf8").slice(-4000)
		: "(no PROGRESS yet)";

	const system = [
		"You are the planning agent of an autonomous SEO loop for leyabierta.es, a",
		"public Spanish legislation site. You propose a concrete, data-grounded action",
		"plan to grow organic traffic. You must obey the PLAYBOOK exactly and output",
		"ONLY a single JSON object matching the plan schema in EVAL.md — no prose.",
		"",
		"=== PLAYBOOK ===",
		playbook,
		"",
		"=== EVAL (scoring + plan schema) ===",
		evalDoc,
		"",
		"=== SEO SURFACE ===",
		SEO_SURFACE,
	].join("\n");

	const user = [
		`Iteration: ${iteration}. Snapshot date: ${gsc.snapshotDate}.`,
		"",
		"=== GSC SNAPSHOT ===",
		JSON.stringify(gsc, null, 1),
		"",
		"=== UMAMI SNAPSHOT ===",
		JSON.stringify(umami, null, 1),
		"",
		"=== STATE ===",
		state,
		"",
		"=== RECENT PROGRESS ===",
		progress,
		"",
		"Produce the plan now. 3–6 independent actions, prioritised per the PLAYBOOK",
		"(striking-distance → low-CTR → rising → coverage). Use camelCase keys:",
		"{ iteration, snapshotDate, model, summary, actions:[{ id, type, hypothesis,",
		"signal, files, change, expectedImpact, effort, requiresHumanReview }],",
		"estimatedCostEur, notes }. Output JSON only.",
	].join("\n");

	return [
		{ role: "system" as const, content: system },
		{ role: "user" as const, content: user },
	];
}

export async function plan(
	model: string,
	gsc: GscSnapshot,
	umami: UmamiSnapshot,
	iteration: number,
): Promise<PlanResult> {
	const messages = buildMessages(gsc, umami, iteration);
	const res = await chat(model, messages, {
		temperature: 0.4,
		maxTokens: 8000,
		jsonObject: true,
	});

	const parsed = extractJson(res.content) as Plan;
	parsed.model = model;
	parsed.iteration = iteration;
	parsed.snapshotDate = gsc.snapshotDate;
	if (!Array.isArray(parsed.actions))
		throw new Error(`${model}: plan.actions is not an array`);

	return {
		plan: parsed,
		meta: {
			model,
			latencyMs: res.latencyMs,
			promptTokens: res.promptTokens,
			completionTokens: res.completionTokens,
		},
	};
}

function loadSnapshots(): { gsc: GscSnapshot; umami: UmamiSnapshot } {
	const gscPath = join(DATA_DIR, "gsc-latest.json");
	const umamiPath = join(DATA_DIR, "umami-latest.json");
	if (!existsSync(gscPath))
		throw new Error(`missing ${gscPath} — run pull-gsc.ts first`);
	if (!existsSync(umamiPath))
		throw new Error(`missing ${umamiPath} — run pull-umami.ts first`);
	return {
		gsc: JSON.parse(readFileSync(gscPath, "utf8")) as GscSnapshot,
		umami: JSON.parse(readFileSync(umamiPath, "utf8")) as UmamiSnapshot,
	};
}

// CLI entry: plan with a single model and write the result.
if (import.meta.main) {
	const model = process.env.MODEL ?? "claude:sonnet";
	const iteration = Number(process.env.SEO_ITERATION ?? 0);
	const { gsc, umami } = loadSnapshots();
	const result = await plan(model, gsc, umami, iteration);
	mkdirSync(DATA_DIR, { recursive: true });
	const safeModel = model.replace(/[^a-z0-9]+/gi, "-");
	const out = join(DATA_DIR, `plan-${safeModel}-${today()}.json`);
	writeFileSync(out, JSON.stringify(result.plan, null, 2));
	console.log(
		`✓ ${out}\n  ${result.plan.actions.length} actions · ${result.meta.latencyMs}ms · ` +
			`${result.meta.promptTokens}+${result.meta.completionTokens} tok\n  ${result.plan.summary}`,
	);
}
