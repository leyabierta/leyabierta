/**
 * Build a structured Markdown review input from an accepted JSONL batch.
 *
 * Given a JSONL of accepted EvalQuestion rows, produces a Markdown file
 * with one section per question that bundles:
 *   - the question text and metadata (voice, materia, difficulty, persona, ...)
 *   - the panel of judge votes
 *   - the seed article text (the (norm, article) the question was generated from)
 *   - the texts of any other expectedArticles
 *   - a reviewer-task placeholder (verdict + 4-axis score + rationale)
 *
 * The output is consumed by a reviewer subagent that fills in verdicts in place.
 * The filled-in markdown is then summarized by `summarize-review.ts`.
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import type { EvalQuestion, JudgeVote } from "../schema.ts";

interface ArticleRow {
	title: string | null;
	current_text: string | null;
}

const SEED_TEXT_LIMIT = 1500;
const ALT_TEXT_LIMIT = 800;

function loadArticle(
	db: Database,
	norm: string,
	article: string,
): ArticleRow | undefined {
	const row = db
		.prepare(
			"SELECT title, current_text FROM blocks WHERE norm_id = ? AND block_id = ?",
		)
		.get(norm, article) as ArticleRow | undefined;
	return row ?? undefined;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n).trimEnd()}…`;
}

function quoteBlock(s: string): string {
	return s
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function formatJudge(vote: JudgeVote): string {
	const reason = vote.reason.replace(/\s+/g, " ").trim();
	return `  - ${vote.model} / ${vote.prompt} (${vote.verdict}): "${truncate(reason, 400)}"`;
}

function formatQuestion(q: EvalQuestion, idx: number, db: Database): string {
	const lines: string[] = [];
	lines.push(`## Q${idx + 1} — ${q.id}`);
	lines.push("");

	const prov = q.provenance;
	const isAgent = prov.source === "agent-generated";
	const persona = isAgent ? prov.persona : "(human-imported)";
	const generator = isAgent
		? `${prov.generatorModel} (${prov.generatorPrompt})`
		: prov.source;
	const judges: JudgeVote[] = isAgent ? (prov.judges ?? []) : [];
	const acc = judges.filter((j) => j.verdict === "accept").length;
	const rej = judges.filter((j) => j.verdict === "reject").length;

	lines.push(`- **Voice:** ${q.voice}`);
	lines.push(`- **Materia:** ${q.materia}`);
	lines.push(`- **Jurisdiction:** ${q.jurisdiction}`);
	lines.push(`- **Persona:** ${persona}`);
	lines.push(`- **Difficulty:** ${q.difficulty}`);
	lines.push(`- **Generator:** ${generator}`);
	if (judges.length > 0) {
		lines.push(`- **Judge votes:** ${acc} accept / ${rej} reject`);
		for (const j of judges) lines.push(formatJudge(j));
	} else {
		lines.push(`- **Judge votes:** (no judge votes recorded)`);
	}
	lines.push("");

	lines.push("### Question");
	lines.push(`> ${q.question}`);
	lines.push("");

	// Seed article
	const seedNorm = isAgent ? prov.seedNorm : "";
	const seedArticle = isAgent ? prov.seedArticle : "";
	lines.push("### Seed (primary article)");
	if (seedNorm && seedArticle) {
		const row = loadArticle(db, seedNorm, seedArticle);
		const title = row?.title ?? "(no title)";
		const text = row?.current_text ?? "(article text not found in DB)";
		lines.push(`**${seedNorm} / ${seedArticle}** — ${title}`);
		lines.push("");
		lines.push(quoteBlock(truncate(text, SEED_TEXT_LIMIT)));
	} else {
		lines.push("(no seed available — non-agent provenance)");
	}
	lines.push("");

	// Other expected articles (skip the seed itself if duplicated)
	const others = q.expectedArticles.filter(
		(a) => !(a.norm === seedNorm && a.article === seedArticle),
	);
	lines.push("### Other expectedArticles");
	if (others.length === 0) {
		lines.push("- (none)");
	} else {
		for (const a of others) {
			const row = loadArticle(db, a.norm, a.article);
			const title = row?.title ?? "(no title)";
			const text = row?.current_text ?? "(text not found in DB)";
			const tag = a.primary ? "primary" : "alternative";
			lines.push(`- **${a.norm} / ${a.article}** (${tag}) — ${title}`);
			lines.push("");
			lines.push(quoteBlock(truncate(text, ALT_TEXT_LIMIT)));
			lines.push("");
		}
	}
	lines.push("");

	lines.push("### Reviewer task");
	lines.push("Verdict: KEEP | MARGINAL | DROP");
	lines.push("Score (0-3 each): C / A / L / S = ?/?/?/? = ?/12");
	lines.push("One-line rationale:");
	lines.push("");
	lines.push("---");
	lines.push("");
	return lines.join("\n");
}

export interface BuildReviewInputOptions {
	inputPath: string;
	outputPath: string;
	dbPath?: string;
}

export function buildReviewInput(opts: BuildReviewInputOptions): {
	outputPath: string;
	count: number;
} {
	const dbPath = opts.dbPath ?? "data/leyabierta.db";
	const raw = readFileSync(opts.inputPath, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const questions: EvalQuestion[] = lines.map(
		(l) => JSON.parse(l) as EvalQuestion,
	);

	const db = new Database(dbPath, { readonly: true });

	const header: string[] = [];
	header.push(`# Review input — ${opts.inputPath.split("/").pop()}`);
	header.push("");
	header.push(`- Source JSONL: \`${opts.inputPath}\``);
	header.push(`- Questions: ${questions.length}`);
	header.push(`- Generated: ${new Date().toISOString()}`);
	header.push("");
	header.push(
		"For each Q below, fill the **Reviewer task** block (Verdict, Score, One-line rationale).",
	);
	header.push(
		"Scoring axes (0-3 each): C = Citizen-likeness/Formal-naturalness, A = Answer-fit, L = No-leakage, S = Specificity. Max 12.",
	);
	header.push(
		"Verdict heuristic: KEEP if total ≥ 10 and no axis = 0; MARGINAL if 7-9 or one axis = 1; DROP if total < 7 or any axis = 0.",
	);
	header.push("");
	header.push("---");
	header.push("");

	const sections: string[] = questions.map((q, i) => formatQuestion(q, i, db));
	db.close();

	const out = `${header.join("\n")}${sections.join("")}`;
	writeFileSync(opts.outputPath, out);
	return { outputPath: opts.outputPath, count: questions.length };
}
