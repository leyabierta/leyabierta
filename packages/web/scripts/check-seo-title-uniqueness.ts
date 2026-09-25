#!/usr/bin/env bun
/**
 * Corpus-level check for lib/seo-title.ts: computes the <title> every law
 * page would get and verifies:
 *   - uniqueness across the whole corpus
 *   - no double parentheses
 *   - no raw ELI jurisdiction code left in a title (e.g. "es-pv" instead of
 *     "País Vasco")
 *   - no title with two different date phrases left in it (a sign
 *     DATE_CLAUSE missed one)
 * …plus reports the length distribution (before/after vs. the pre-#211
 * scheme) and the share of titles that still had to be truncated with "…".
 *
 * Not part of `bun test` / CI: the SQLite DB (`data/leyabierta.db`) is
 * gitignored and not available there. Run manually after touching
 * seo-title.ts, or whenever the corpus changes meaningfully:
 *
 *   bun run packages/web/scripts/check-seo-title-uniqueness.ts [--db path] [--samples N]
 *
 * Exits 1 (and prints details) on any failure.
 */
import { Database } from "bun:sqlite";
import { codePointLength } from "../src/lib/meta-description.ts";
import { DATE_PHRASE, seoLawPageTitle } from "../src/lib/seo-title.ts";

interface Args {
	db: string;
	samples: number;
}

function parseArgs(argv: string[]): Args {
	const db =
		argv[argv.indexOf("--db") + 1] ??
		process.env.DB_PATH ??
		"data/leyabierta.db";
	const samplesArg = argv[argv.indexOf("--samples") + 1];
	const samples = samplesArg ? Number.parseInt(samplesArg, 10) : 20;
	return { db, samples };
}

interface Row {
	id: string;
	rank: string;
	title: string;
	jurisdiction: string;
	published_at: string;
}

// The pre-#211 scheme, for the before/after comparison in the report:
// abbreviation dropped whenever the subject alone didn't leave room for it,
// and no jurisdiction/id fallback at all.
const OLD_ABBREVS: Record<string, string> = {
	real_decreto: "RD",
	ley_organica: "LO",
	ley: "L",
	real_decreto_ley: "RDL",
	real_decreto_legislativo: "RDLeg",
	orden: "O",
	decreto: "D",
	resolucion: "Res",
};
function oldTitle(row: Row): string {
	const abbrev = OLD_ABBREVS[row.rank] ?? "";
	let seoAbbrev = "";
	if (abbrev) {
		const numMatch = row.title.match(/(\d+\/\d{4})/);
		if (numMatch) seoAbbrev = `${abbrev} ${numMatch[1]}`;
	}
	const base = seoAbbrev ? `${seoAbbrev} — ${row.title}` : row.title;
	return `${base} — Ley Abierta`;
}

function percentile(arr: number[], p: number): number {
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
	return sorted[idx]!;
}

// Raw ELI jurisdiction codes ("es-pv", "es-md", …) — must never survive into
// a <title>; lib/seo-title.ts maps them to a human name (JURISDICTION_LABELS)
// or skips the mention entirely when the subject already names the community.
const ELI_CODE = /\bes-[a-z]{2}\b/;

function main() {
	const { db: dbPath, samples } = parseArgs(process.argv.slice(2));
	const db = new Database(dbPath, { readonly: true });
	const rows = db
		.query("SELECT id, rank, title, jurisdiction, published_at FROM norms")
		.all() as Row[];
	db.close();

	const byTitle = new Map<string, string[]>();
	const oldLens: number[] = [];
	const newLens: number[] = [];
	let oldLe60 = 0;
	let oldLe70 = 0;
	let newLe60 = 0;
	let newLe70 = 0;
	let ellipsisCount = 0;
	const doubleParens: string[] = [];
	const eliCodes: string[] = [];
	const twoDates: string[] = [];

	for (const row of rows) {
		const title = seoLawPageTitle({
			id: row.id,
			titulo: row.title,
			rango: row.rank,
			jurisdiccion: row.jurisdiction,
		});
		const arr = byTitle.get(title) ?? [];
		arr.push(row.id);
		byTitle.set(title, arr);

		if ((title.match(/\(/g)?.length ?? 0) > 1) {
			doubleParens.push(`${row.id}: ${title}`);
		}
		if (ELI_CODE.test(title)) {
			eliCodes.push(`${row.id}: ${title}`);
		}
		if ((title.match(DATE_PHRASE)?.length ?? 0) > 1) {
			twoDates.push(`${row.id}: ${title}`);
		}
		if (title.includes("…")) ellipsisCount++;

		const nl = codePointLength(title);
		newLens.push(nl);
		if (nl <= 60) newLe60++;
		if (nl <= 70) newLe70++;

		const ol = codePointLength(oldTitle(row));
		oldLens.push(ol);
		if (ol <= 60) oldLe60++;
		if (ol <= 70) oldLe70++;
	}

	const n = rows.length;
	const collidingGroups = [...byTitle.entries()].filter(
		([, ids]) => ids.length > 1,
	);
	const collidingNorms = collidingGroups.reduce(
		(sum, [, ids]) => sum + ids.length,
		0,
	);

	console.log(`N = ${n}`);
	console.log(
		`BEFORE  p50=${percentile(oldLens, 0.5)}  p90=${percentile(oldLens, 0.9)}  max=${Math.max(...oldLens)}  ≤60=${((oldLe60 / n) * 100).toFixed(1)}%  ≤70=${((oldLe70 / n) * 100).toFixed(1)}%`,
	);
	console.log(
		`AFTER   p50=${percentile(newLens, 0.5)}  p90=${percentile(newLens, 0.9)}  max=${Math.max(...newLens)}  ≤60=${((newLe60 / n) * 100).toFixed(1)}%  ≤70=${((newLe70 / n) * 100).toFixed(1)}%`,
	);
	console.log(
		`\nUniqueness: ${byTitle.size} distinct <title>s for ${n} norms — ${collidingGroups.length} colliding groups covering ${collidingNorms} norms (${((collidingNorms / n) * 100).toFixed(2)}%)`,
	);
	console.log(
		`Ellipsis ("…"): ${ellipsisCount} / ${n} titles still truncated (${((ellipsisCount / n) * 100).toFixed(1)}%)`,
	);

	if (collidingGroups.length > 0) {
		console.log("\nColliding groups:");
		for (const [title, ids] of collidingGroups.slice(0, 50)) {
			console.log(`  "${title}"\n    ${ids.join(", ")}`);
		}
	}

	console.log(
		`\nDouble parentheses: ${doubleParens.length} titles with more than one "("`,
	);
	for (const line of doubleParens.slice(0, 20)) console.log(`  ${line}`);

	console.log(`\nRaw ELI codes: ${eliCodes.length} titles`);
	for (const line of eliCodes.slice(0, 20)) console.log(`  ${line}`);

	console.log(`\nTwo date phrases left: ${twoDates.length} titles`);
	for (const line of twoDates.slice(0, 20)) console.log(`  ${line}`);

	console.log(`\n${samples} random samples:`);
	const shuffled = [...rows].sort(() => Math.random() - 0.5).slice(0, samples);
	for (const row of shuffled) {
		const after = seoLawPageTitle({
			id: row.id,
			titulo: row.title,
			rango: row.rank,
			jurisdiccion: row.jurisdiction,
		});
		console.log(`ID: ${row.id}`);
		console.log(
			`  BEFORE (${codePointLength(oldTitle(row))}): ${oldTitle(row)}`,
		);
		console.log(`  AFTER  (${codePointLength(after)}): ${after}`);
	}

	let failed = false;
	if (collidingGroups.length > 0) {
		console.error(
			`\nFAIL: ${collidingGroups.length} colliding <title> groups found.`,
		);
		failed = true;
	}
	if (doubleParens.length > 0) {
		console.error(
			`\nFAIL: ${doubleParens.length} titles with double parentheses.`,
		);
		failed = true;
	}
	if (eliCodes.length > 0) {
		console.error(`\nFAIL: ${eliCodes.length} titles with a raw ELI code.`);
		failed = true;
	}
	if (twoDates.length > 0) {
		console.error(
			`\nFAIL: ${twoDates.length} titles with two date phrases left in them.`,
		);
		failed = true;
	}
	if (failed) process.exit(1);
	console.log(
		"\nOK: every <title> in the corpus is unique, no double parentheses, no raw ELI codes, no leftover double dates.",
	);
}

main();
