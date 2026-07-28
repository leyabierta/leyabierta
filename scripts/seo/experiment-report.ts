#!/usr/bin/env bun
// Read the URL-shape experiment off the inspection cache.
//
//   bun run scripts/seo/experiment-report.ts
//
// Treatment (2026 reforms, path URLs) vs control (older reforms, query URLs).
// The metric that decides it is `crawlRate`, not `indexedRate`: Google has to
// fetch a page before it can judge it, and the reform cohort is stuck at the
// fetch step. See packages/web/src/lib/reform-experiment.ts for the hypothesis
// and the vault note 2026-07-28-reform-url-shape for the success criteria.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cohortOf, DATA_DIR, type UrlInspection } from "./lib.ts";

// Pre-registered thresholds — see the vault note. Stated here so the script
// reports a verdict instead of leaving it to whoever reads the numbers.
const SUCCESS_TREATMENT_CRAWL = 0.2;
const SUCCESS_CONTROL_CRAWL = 0.05;
const MIN_SAMPLE = 200;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function main() {
	const path = join(DATA_DIR, "inspections.json");
	if (!existsSync(path)) {
		console.error(`No inspection cache at ${path}. Run inspect-urls.ts first.`);
		process.exit(1);
	}
	const all = (
		JSON.parse(readFileSync(path, "utf8")) as UrlInspection[]
	).filter((i) => !i.error);

	const groups = new Map<string, UrlInspection[]>();
	for (const i of all) {
		const c = cohortOf(i.url);
		const bucket = groups.get(c);
		if (bucket) bucket.push(i);
		else groups.set(c, [i]);
	}

	console.log(`Inspecciones en caché: ${all.length}\n`);
	console.log(
		`${"cohorte".padEnd(15)}${"n".padStart(6)}${"rastreadas".padStart(14)}${"indexadas".padStart(13)}`,
	);
	console.log("─".repeat(48));

	for (const [name, items] of [...groups].sort()) {
		const crawled = items.filter((i) => i.lastCrawlTime).length;
		const indexed = items.filter((i) => i.verdict === "PASS").length;
		console.log(
			name.padEnd(15) +
				String(items.length).padStart(6) +
				`${crawled} (${pct(crawled / items.length)})`.padStart(14) +
				`${indexed} (${pct(indexed / items.length)})`.padStart(13),
		);
	}

	const treatment = groups.get("reforma-path") ?? [];
	const control = groups.get("reforma-query") ?? [];
	if (!treatment.length || !control.length) {
		console.log("\nAún no hay ambas cohortes en la caché — nada que comparar.");
		return;
	}

	const tRate =
		treatment.filter((i) => i.lastCrawlTime).length / treatment.length;
	const cRate = control.filter((i) => i.lastCrawlTime).length / control.length;

	console.log(
		`\nTratamiento (path): ${pct(tRate)} rastreadas de ${treatment.length}`,
	);
	console.log(
		`Control (query):    ${pct(cRate)} rastreadas de ${control.length}`,
	);

	if (treatment.length < MIN_SAMPLE || control.length < MIN_SAMPLE) {
		console.log(
			`\n⏳ Muestra insuficiente (mínimo ${MIN_SAMPLE} por cohorte). Sigue midiendo.`,
		);
		return;
	}
	if (tRate > SUCCESS_TREATMENT_CRAWL && cRate < SUCCESS_CONTROL_CRAWL) {
		console.log("\n✅ ÉXITO: la forma de URL era el bloqueo. Migrar el resto.");
	} else if (tRate < SUCCESS_CONTROL_CRAWL) {
		console.log(
			"\n❌ FRACASO: el path no desbloquea el rastreo. El problema es autoridad o presupuesto de rastreo, no la URL.",
		);
	} else {
		console.log(
			"\n🤔 AMBIGUO: ni éxito claro ni fracaso claro. Ampliar la ventana antes de concluir.",
		);
	}
}

main();
