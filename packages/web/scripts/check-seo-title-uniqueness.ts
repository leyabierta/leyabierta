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
import { JURISDICTION_LABELS } from "../src/lib/law-search.ts";
import { codePointLength } from "../src/lib/meta-description.ts";
import {
	BARE_PREPOSITION_START,
	DATE_PHRASE,
	JURISDICTION_NAME_ALIASES,
	seoLawPageTitle,
	VERB_NOMINALIZATION,
} from "../src/lib/seo-title.ts";

interface Args {
	db: string;
	samples: number;
}

function parseArgs(argv: string[]): Args {
	// indexOf() is -1 when a flag is absent: guard it, or `argv[0]` (e.g.
	// "--samples") would be read as the DB path / sample count.
	const flagValue = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i === -1 ? undefined : argv[i + 1];
	};
	const db = flagValue("--db") ?? process.env.DB_PATH ?? "data/leyabierta.db";
	const samplesArg = flagValue("--samples");
	const samples =
		samplesArg === undefined ? 20 : Number.parseInt(samplesArg, 10);
	if (!Number.isInteger(samples) || samples < 0) {
		throw new Error(
			`--samples expects a non-negative integer, got "${samplesArg}"`,
		);
	}
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

/** The subject portion of a <title>: strip the trailing " (disambiguator)"
 * and " — Ley Abierta" suffix, leaving what a reader sees as the headline. */
function subjectOf(title: string): string {
	return title.replace(/ — Ley Abierta$/, "").replace(/ \([^()]*\)$/, "");
}

const VERB_WORDS = new Set(Object.keys(VERB_NOMINALIZATION));

// Glitches found in the #211 fourth review, each asserted corpus-wide:
// punctuation left as the first character (a date clause with a source typo),
// a doubled "de" from a nominalization, a compound rank word cut in half
// ("Foral 11/2019…", "Legislativo 1/2019…"), and a numbered autonomic law
// whose community can't be read anywhere in the visible <title>.
const LEADING_PUNCT = /^[.,;:]/;
const DOUBLE_DE = /\bde\s+de\b/i;
const RANK_FRAGMENT_START = /^(?:Foral|Legislativo|Org[aá]nica)\s/;
const NUMBERED_DISAMBIG = /\([^()]*\d+\/\d{4}[^()]*\)/;

function communityVisible(title: string, jurisdiction: string): boolean {
	if (!jurisdiction || jurisdiction === "es") return true;
	if (!NUMBERED_DISAMBIG.test(title)) return true; // id disambiguator: unique by itself
	const lower = title.toLowerCase();
	const names = [
		...(JURISDICTION_NAME_ALIASES[jurisdiction] ?? []),
		(JURISDICTION_LABELS[jurisdiction] ?? "").toLowerCase(),
	].filter(Boolean);
	return names.some((name) => lower.includes(name));
}

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
	const badStarts: string[] = [];
	const glitches: string[] = [];
	const hiddenCommunity: string[] = [];
	const firstWordCounts = new Map<string, number>();

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
		if (
			LEADING_PUNCT.test(title) ||
			DOUBLE_DE.test(title) ||
			RANK_FRAGMENT_START.test(title)
		) {
			glitches.push(`${row.id}: ${title}`);
		}
		if (!communityVisible(title, row.jurisdiction)) {
			hiddenCommunity.push(`${row.id} (${row.jurisdiction}): ${title}`);
		}

		const subject = subjectOf(title);
		const firstWord = subject
			.split(/\s+/)[0]
			?.toLowerCase()
			.replace(/[.,;:]$/, "");
		if (firstWord) {
			firstWordCounts.set(firstWord, (firstWordCounts.get(firstWord) ?? 0) + 1);
			if (VERB_WORDS.has(firstWord) || BARE_PREPOSITION_START.test(subject)) {
				badStarts.push(`${row.id}: ${title}`);
			}
		}

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

	console.log(
		`\nBad subject starts (conjugated verb or bare preposition fragment): ${badStarts.length} titles`,
	);
	for (const line of badStarts.slice(0, 30)) console.log(`  ${line}`);

	console.log(
		`\nGlitches (leading punctuation, "de de", half a rank word): ${glitches.length} titles`,
	);
	for (const line of glitches.slice(0, 20)) console.log(`  ${line}`);

	console.log(
		`\nNumbered autonomic laws with no visible community: ${hiddenCommunity.length} titles`,
	);
	for (const line of hiddenCommunity.slice(0, 20)) console.log(`  ${line}`);

	const topFirstWords = [...firstWordCounts.entries()].sort(
		(a, b) => b[1] - a[1],
	);
	console.log("\nTop 25 first words of the subject (after):");
	for (const [word, count] of topFirstWords.slice(0, 25)) {
		console.log(`  ${count}\t${word}`);
	}

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
	if (badStarts.length > 0) {
		console.error(
			`\nFAIL: ${badStarts.length} titles start with a conjugated verb or a bare preposition fragment.`,
		);
		failed = true;
	}
	if (glitches.length > 0) {
		console.error(
			`\nFAIL: ${glitches.length} titles with leading punctuation, "de de" or half a rank word.`,
		);
		failed = true;
	}
	if (hiddenCommunity.length > 0) {
		console.error(
			`\nFAIL: ${hiddenCommunity.length} numbered autonomic titles don't show their community.`,
		);
		failed = true;
	}
	if (failed) process.exit(1);
	console.log(
		'\nOK: every <title> in the corpus is unique, no double parentheses, no raw ELI codes, no leftover double dates, no verb-first/fragment subjects, no punctuation/"de de"/half-rank glitches, every numbered autonomic title shows its community.',
	);
}

main();
