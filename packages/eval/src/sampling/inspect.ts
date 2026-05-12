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

	// ── Smoke: per-norm cap (Task 1 / fix #6.1) ───────────────────────────
	// Three back-to-back batches of 20 with maxPerNorm=2, threading
	// `seenSeeds` between calls. Verifies no norm appears more than 2 times
	// across the 60 total seeds.
	{
		const seen = new Set<string>();
		const allSeeds: { normId: string; jurisdiction: string }[] = [];
		for (let i = 0; i < 3; i++) {
			const batch = await sampler.sample({
				n: 20,
				seenSeeds: seen,
				maxPerNorm: 2,
			});
			for (const s of batch) {
				seen.add(`${s.normId}#${s.articleId}`);
				allSeeds.push({ normId: s.normId, jurisdiction: s.jurisdiction });
			}
		}
		const normCounts = new Map<string, number>();
		for (const s of allSeeds)
			normCounts.set(s.normId, (normCounts.get(s.normId) ?? 0) + 1);
		const overCap = Array.from(normCounts.entries()).filter(([, n]) => n > 2);
		const distinctNorms = normCounts.size;
		console.log(
			`\n=== Smoke: per-norm cap (3×n=20, maxPerNorm=2) ===\n` +
				`total seeds: ${allSeeds.length}   distinct norms: ${distinctNorms}   ` +
				`norms over cap: ${overCap.length}   ` +
				`(max draws on a single norm: ${Math.max(0, ...normCounts.values())})`,
		);
	}

	// ── Smoke: jurisdiction diversity (Task 3 / fix #6.3) ─────────────────
	// Single batch of 20 should now contain at least 3 distinct jurisdictions
	// when the corpus has them, instead of the all-`es` we saw in the pilot.
	{
		const batch = await sampler.sample({ n: 20, seenSeeds: new Set() });
		const byJur = new Map<string, number>();
		for (const s of batch)
			byJur.set(s.jurisdiction, (byJur.get(s.jurisdiction) ?? 0) + 1);
		const dist = Array.from(byJur.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([j, n]) => `${j}=${n}`)
			.join(", ");
		console.log(
			`\n=== Smoke: jurisdiction diversity (n=20) ===\n` +
				`distinct jurisdictions: ${byJur.size}   distribution: ${dist}`,
		);
	}

	// ── Realistic pilot simulation ────────────────────────────────────────
	// Smoke tests above use a single 60-seed run with maxPerNorm=2 and a
	// single 20-seed batch — neither catches multi-batch bugs because the
	// run-level state (jurisdiction emitted counts, per-norm counters) is
	// effectively reset within one call. The pilot 50 actually issued ~25
	// batches of n=2 from the pipeline, and it's the *interaction* of
	// those batches that produced the all-(es,es-ct) outcome.
	//
	// This block reproduces that workload: 34 batches of 2 = 68 seeds
	// (matches the actual pilot 50 seed budget given dropouts), with the
	// production-default `maxPerNorm: 3` and the default jurisdiction
	// shares. We re-instantiate the sampler so its run-level state is
	// fresh, independent of the smoke runs above.
	{
		const realSampler = new StratifiedSampler({ dbPath });
		const seen = new Set<string>();
		const allSeeds: {
			normId: string;
			jurisdiction: string;
			materia: string;
		}[] = [];
		for (let i = 0; i < 34; i++) {
			const batch = await realSampler.sample({
				n: 2,
				seenSeeds: seen,
				maxPerNorm: 3,
			});
			for (const s of batch) {
				seen.add(`${s.normId}#${s.articleId}`);
				allSeeds.push({
					normId: s.normId,
					jurisdiction: s.jurisdiction,
					materia: s.materia,
				});
			}
		}

		const normCounts = new Map<string, number>();
		const jurCounts = new Map<string, number>();
		const materiaCounts = new Map<string, number>();
		for (const s of allSeeds) {
			normCounts.set(s.normId, (normCounts.get(s.normId) ?? 0) + 1);
			jurCounts.set(s.jurisdiction, (jurCounts.get(s.jurisdiction) ?? 0) + 1);
			materiaCounts.set(s.materia, (materiaCounts.get(s.materia) ?? 0) + 1);
		}
		const total = allSeeds.length;
		const maxNorm = Math.max(0, ...normCounts.values());
		const distinctJurs = jurCounts.size;
		const jurDist = Array.from(jurCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([j, n]) => `${j}=${n} (${((n / total) * 100).toFixed(0)}%)`)
			.join(", ");
		const topMat = Array.from(materiaCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([m, n]) => `${m}=${n}`)
			.join(", ");

		console.log(
			`\n=== Realistic pilot simulation (34 batches × n=2, maxPerNorm=3) ===`,
		);
		console.log(`  total seeds: ${total}`);
		console.log(`  distinct norms: ${normCounts.size}`);
		console.log(`  max draws on a single norm: ${maxNorm}  (target ≤ 3)`);
		console.log(`  distinct jurisdictions: ${distinctJurs}  (target ≥ 4)`);
		console.log(`  jurisdiction distribution: ${jurDist}`);
		console.log(`  top materias: ${topMat}`);

		// Citizen-pain materias surfaced (case-insensitive substring match;
		// the boost map uses canonical names but corpus tags vary).
		const painPatterns = [
			["Trabajo", /trabaj/i],
			["Vivienda", /vivienda|arrenda/i],
			["IRPF/IVA", /irpf|iva|impuesto/i],
		] as const;
		for (const [label, rx] of painPatterns) {
			let hits = 0;
			for (const [m, n] of materiaCounts) {
				if (rx.test(m)) hits += n;
			}
			console.log(`  pain check — ${label}: ${hits} seed(s)`);
		}

		realSampler.close();
	}

	sampler.close();
}

await main();
