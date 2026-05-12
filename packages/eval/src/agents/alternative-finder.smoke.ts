/**
 * Manual smoke test for the Alternative Finder.
 *
 * Loads HERMES_API_KEY, opens data/leyabierta.db, runs 5 hand-picked
 * citizen questions where we'd EXPECT alternatives (e.g. ET + reglamento,
 * LAU + LEC, LPRL + LGSS), prints BM25 candidates, the LLM verdicts and
 * the accepted alternatives, plus aggregated stats.
 *
 *   bun --env-file=.env run packages/eval/src/agents/alternative-finder.smoke.ts
 */

import { Database } from "bun:sqlite";
import { makeQwenClient, startEvalTrace } from "../llm/index.ts";
import { makeAlternativeFinderAgent } from "./alternative-finder.ts";

interface Case {
	label: string;
	question: string;
	primary: { norm: string; article: string };
}

const CASES: Case[] = [
	{
		label: "casero quiere echarme (LAU + LEC?)",
		question:
			"El casero quiere echarme porque dice que llevo dos meses sin pagar el alquiler, ¿qué puede hacer y qué puedo hacer yo?",
		primary: { norm: "BOE-A-1994-26003", article: "a27" },
	},
	{
		label: "accidente de trabajo (LPRL + LGSS?)",
		question:
			"Tuve un accidente trabajando en una obra y me he roto el brazo, ¿qué tengo que hacer y de qué responde mi empresa?",
		primary: { norm: "BOE-A-1995-24292", article: "a42" },
	},
	{
		label: "despido sin causa (ET + LRJS?)",
		question:
			"Me han despedido sin darme ningún motivo, ¿es despido improcedente y qué indemnización me corresponde?",
		primary: { norm: "BOE-A-2015-11430", article: "a56" },
	},
	{
		label: "vacaciones anuales (ET)",
		question:
			"Cuántos días de vacaciones tengo derecho al año si trabajo a jornada completa y cómo se fija el periodo de disfrute",
		primary: { norm: "BOE-A-2015-11430", article: "a38" },
	},
	{
		label: "permiso por nacimiento (ET)",
		question:
			"Cuánto dura el permiso por nacimiento de hijo y suspensión del contrato para el padre",
		primary: { norm: "BOE-A-2015-11430", article: "a48" },
	},
];

async function main() {
	const apiKey = process.env.HERMES_API_KEY;
	if (!apiKey) {
		console.log("[smoke] no HERMES_API_KEY, skipping");
		process.exit(0);
	}

	const db = new Database("data/leyabierta.db", { readonly: true });
	const trace = startEvalTrace(
		"alternative-finder-smoke",
		{ test: "alternative-finder" },
		["eval", "smoke", "alternative-finder"],
	);
	const qwen = makeQwenClient(apiKey, "smoke-alt-finder");

	const finder = makeAlternativeFinderAgent({
		db,
		llm: qwen,
		trace,
		maxCandidates: 8,
	});

	let withAlternatives = 0;

	for (const c of CASES) {
		console.log("─".repeat(72));
		console.log(`[case] ${c.label}`);
		console.log(`  Q: ${c.question}`);
		console.log(`  primary: ${c.primary.norm} / ${c.primary.article}`);

		const before = finder.stats.candidatesPerCall.length;
		const alts = await finder.find(c.question, {
			norm: c.primary.norm,
			article: c.primary.article,
			primary: true,
		});
		const candidatesThisCall = finder.stats.candidatesPerCall[before] ?? 0;
		console.log(`  BM25 candidates: ${candidatesThisCall}`);
		console.log(`  accepted alternatives (${alts.length}):`);
		for (const a of alts) {
			const row = db
				.prepare("SELECT title FROM blocks WHERE norm_id = ? AND block_id = ?")
				.get(a.norm, a.article) as { title?: string } | undefined;
			console.log(`    + ${a.norm} / ${a.article}  ${row?.title ?? ""}`);
		}
		if (alts.length > 0) withAlternatives += 1;
	}

	console.log("─".repeat(72));
	console.log("[stats]", JSON.stringify(finder.stats, null, 2));
	console.log(
		`[summary] ${withAlternatives}/${CASES.length} cases produced ≥1 alternative`,
	);

	trace.end({ withAlternatives, total: CASES.length, stats: finder.stats });
	db.close();
}

await main();
