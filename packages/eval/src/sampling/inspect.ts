/**
 * CLI: `bun run packages/eval/src/sampling/inspect.ts`
 *
 * Prints the corpus distribution by (materia × jurisdiction × rank × decade)
 * and how many seeds each cell would receive given the default quota table.
 *
 * Pure read-only. Used as a sanity check before kicking off the (expensive)
 * agent pipeline.
 */

import { parseCellKey } from "./quotas.ts";
import { DEFAULT_DB_PATH, StratifiedSampler } from "./strata.ts";

function pad(s: string | number, n: number): string {
	const v = String(s);
	return v.length >= n ? v : v + " ".repeat(n - v.length);
}

function rpad(s: string | number, n: number): string {
	const v = String(s);
	return v.length >= n ? v : " ".repeat(n - v.length) + v;
}

function aggregate<K extends string>(
	cells: Map<string, number>,
	pickKey: (c: ReturnType<typeof parseCellKey>) => K,
): Map<K, number> {
	const out = new Map<K, number>();
	for (const [k, v] of cells) {
		const c = parseCellKey(k);
		const key = pickKey(c);
		out.set(key, (out.get(key) ?? 0) + v);
	}
	return out;
}

function printTable(
	title: string,
	header: string[],
	rows: (string | number)[][],
	widths: number[],
): void {
	console.log(`\n=== ${title} ===`);
	const pads = (cells: (string | number)[]) =>
		cells
			.map((c, i) => (i === 0 ? pad(c, widths[i]!) : rpad(c, widths[i]!)))
			.join("  ");
	console.log(pads(header));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const r of rows) console.log(pads(r));
}

async function main(): Promise<void> {
	const dbPath = process.env.LEYABIERTA_DB ?? DEFAULT_DB_PATH;
	const sampler = new StratifiedSampler({ dbPath });
	const snap = sampler.getSnapshot();

	console.log(`DB: ${dbPath}`);
	console.log(`Norms (vigente): ${snap.totalNormsVigente}`);
	console.log(
		`Eligible articles (vigente, precepto, a*, ≥200 chars): ${snap.totalArticlesEligible}`,
	);
	console.log(
		`Cells populated: ${snap.cellCounts.size}   Total seed quota: ${snap.quotas.totalTarget}`,
	);

	// Top materias.
	printTable(
		"Top 30 materias (by # vigente norms)",
		["materia", "norms"],
		snap.topMaterias.slice(0, 30).map((m) => [m.materia, m.norms]),
		[55, 8],
	);

	// Jurisdictions.
	printTable(
		"Jurisdictions",
		["jurisdiction", "norms", "bucket"],
		snap.jurisdictions.map((j) => [j.jurisdiction, j.norms, j.bucket]),
		[16, 8, 14],
	);

	// Cell counts and quotas, aggregated by each axis.
	const articlesByMateria = aggregate(snap.cellCounts, (c) => c.materia);
	const articlesByJur = aggregate(snap.cellCounts, (c) => c.jurisdiction);
	const articlesByRank = aggregate(snap.cellCounts, (c) => c.rank);
	const articlesByDecade = aggregate(snap.cellCounts, (c) => c.decade);
	const seedsByMateria = aggregate(snap.quotas.targets, (c) => c.materia);
	const seedsByJur = aggregate(snap.quotas.targets, (c) => c.jurisdiction);
	const seedsByRank = aggregate(snap.quotas.targets, (c) => c.rank);
	const seedsByDecade = aggregate(snap.quotas.targets, (c) => c.decade);

	const aggRows = (
		articles: Map<string, number>,
		seeds: Map<string, number>,
	): [string, number, number][] =>
		Array.from(articles.entries())
			.map(([k, n]) => [k, n, seeds.get(k) ?? 0] as [string, number, number])
			.sort((a, b) => b[1] - a[1]);

	printTable(
		"By materia (cells aggregate articles × N materias)",
		["materia", "articles", "seeds"],
		aggRows(articlesByMateria, seedsByMateria),
		[55, 10, 8],
	);
	printTable(
		"By jurisdiction",
		["jurisdiction", "articles", "seeds"],
		aggRows(articlesByJur, seedsByJur),
		[16, 10, 8],
	);
	printTable(
		"By rank",
		["rank", "articles", "seeds"],
		aggRows(articlesByRank, seedsByRank),
		[28, 10, 8],
	);
	printTable(
		"By decade",
		["decade", "articles", "seeds"],
		aggRows(articlesByDecade, seedsByDecade),
		[10, 10, 8],
	);

	// Top 25 hottest cells.
	const hottest = Array.from(snap.cellCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25)
		.map(([k, n]) => {
			const c = parseCellKey(k);
			return [
				c.materia,
				c.jurisdiction,
				c.rank,
				c.decade,
				n,
				snap.quotas.targets.get(k) ?? 0,
			];
		});
	printTable(
		"Top 25 hottest cells",
		["materia", "jur", "rank", "dec", "articles", "seeds"],
		hottest,
		[42, 8, 24, 8, 10, 6],
	);

	sampler.close();
}

await main();
