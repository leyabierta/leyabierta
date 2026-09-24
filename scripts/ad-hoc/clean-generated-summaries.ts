/**
 * Cleanup of generated citizen content found by the 2026-09-24 audit.
 *
 * Why it was needed: before the per-article paths were unified (shared
 * generator + validation in packages/pipeline/src/ai/article-summary.ts),
 * older prompts and imports let through text that today's validation
 * rejects, and model ids were recorded in two spellings:
 *
 *   a) reform_summaries.model: the offline import stored the vLLM served name
 *      `qwen3.8-27b` for what the cron stores as `qwen/qwen3.8-27b` (same
 *      weights). Normalized in place.
 *   b) citizen_article_summaries written in the second person ("Tienes
 *      derecho…", "tus deudas") or longer than 600 characters (the absolute
 *      cap). Deleted, with their article-level tags, so they are generated
 *      again (lazy API route, or the offline export of articles without a
 *      summary). Reform summaries in the second person are only LISTED: the
 *      Batch API reprocessing (reform-summaries-offline.ts export
 *      --regenerate-existing → batch → import --replace-from) replaces every
 *      published reform summary and its import rejects the second person.
 *   c) omnibus_topics with no summary and no articles (an empty heading on
 *      /omnibus): deleted. Topics with a summary but article_count 0 are
 *      listed for review, not touched. generate-omnibus-topics.ts no longer
 *      stores empty topics.
 *
 * Dry run by default: prints what it would change. With --apply it first
 * writes a JSON backup of every row it deletes or changes (--backup FILE is
 * required), then applies everything in one transaction. Idempotent: a second
 * run finds nothing.
 *
 * HOW TO RUN IN PRODUCTION — `scripts/` is not in the Docker image; copy it in
 * and exec it, dry run first, never while another `docker exec` writes:
 *
 *   docker cp scripts/ad-hoc/clean-generated-summaries.ts code-api-1:/tmp/
 *   docker exec code-api-1 bun run /tmp/clean-generated-summaries.ts /data/leyabierta.db
 *   docker exec code-api-1 bun run /tmp/clean-generated-summaries.ts /data/leyabierta.db \
 *     --apply --backup /data/clean-generated-summaries-backup.json
 *   # copy the backup out to /opt/leyabierta/logs/, then remove /tmp and /data copies
 *
 * Usage: clean-generated-summaries.ts [db-path] [--apply --backup FILE]
 */

import { Database } from "bun:sqlite";

const args = process.argv.slice(2);
const dbPath =
	args[0] && !args[0].startsWith("--") ? args[0] : "./data/leyabierta.db";
const apply = args.includes("--apply");
const backupPath = args.includes("--backup")
	? args[args.indexOf("--backup") + 1]
	: undefined;
if (apply && (!backupPath || backupPath.startsWith("--"))) {
	console.error("--apply needs --backup FILE (rows are deleted)");
	process.exit(1);
}

// The validation's second-person words (packages/pipeline ai/article-summary.ts)
// plus unambiguous second-person pronouns and possessives. Not "ti" (matches
// "TI", tecnologías de la información) nor "os" ("hijas/os"). Case-sensitive,
// lowercase or capitalized only: acronyms such as "TE" (tecnificación
// deportiva) or "ERES" (expedientes de regulación de empleo) are not words.
const SECOND_PERSON_WORDS = [
	"tú",
	"tu",
	"tus",
	"te",
	"contigo",
	"tienes",
	"puedes",
	"debes",
	"usted",
	"ustedes",
	"eres",
	"estás",
];
const SECOND_PERSON = new RegExp(
	`(?<![\\p{L}\\p{N}])(${SECOND_PERSON_WORDS.flatMap((w) => [w, w[0]?.toUpperCase() + w.slice(1)]).join("|")})(?![\\p{L}\\p{N}])`,
	"gu",
);
/**
 * Second-person words of a summary that the article itself does not use: a
 * word quoted from the law (e.g. "usted" in the forms of address of the
 * military ordinances) is not the summary addressing the reader.
 */
function secondPersonWords(summary: string, articleText: string): string[] {
	const inText = new Set(
		(articleText.match(SECOND_PERSON) ?? []).map((w) => w.toLowerCase()),
	);
	// A summary cut mid-word ("…de naturaleza te", "…lengua y tu") ends in a
	// fragment, not a pronoun: drop the last word when there is no final
	// punctuation. (Truncated summaries are a separate problem, not handled here.)
	const body = /[.)»"”:;!?]$/.test(summary.trim())
		? summary
		: summary.trim().replace(/\S+$/, "");
	return [...new Set(body.match(SECOND_PERSON) ?? [])].filter(
		(w) => !inText.has(w.toLowerCase()),
	);
}
const MAX_SUMMARY_CHARS = 600;

const db = new Database(dbPath, apply ? {} : { readonly: true });

// a) model ids
const modelRows = db
	.query<{ n: number }, []>(
		"SELECT count(*) AS n FROM reform_summaries WHERE model = 'qwen3.8-27b'",
	)
	.get()?.n;

// b) article summaries
type ArticleRow = { norm_id: string; block_id: string; summary: string };
const articles = db
	.query<ArticleRow, []>(
		"SELECT norm_id, block_id, summary FROM citizen_article_summaries WHERE summary != ''",
	)
	.all();
const articleText = db.query<{ text: string }, [string, string]>(
	"SELECT current_text AS text FROM blocks WHERE norm_id = ? AND block_id = ?",
);
const secondPerson = articles.filter(
	(r) =>
		secondPersonWords(
			r.summary,
			articleText.get(r.norm_id, r.block_id)?.text ?? "",
		).length > 0,
);
const flagged = new Set(secondPerson);
const tooLong = articles.filter(
	(r) => r.summary.length > MAX_SUMMARY_CHARS && !flagged.has(r),
);
const toDelete = [...secondPerson, ...tooLong];
const tagsOf = db.query<{ tag: string }, [string, string]>(
	"SELECT tag FROM citizen_tags WHERE norm_id = ? AND block_id = ?",
);

type ReformRow = {
	norm_id: string;
	source_id: string;
	reform_date: string;
	headline: string;
	summary: string;
	model: string;
};
const reformsSecondPerson = db
	.query<ReformRow, []>(
		"SELECT norm_id, source_id, reform_date, headline, summary, model FROM reform_summaries",
	)
	.all()
	.filter(
		(r) => (`${r.headline} ${r.summary}`.match(SECOND_PERSON) ?? []).length > 0,
	);

// c) omnibus topics
type TopicRow = {
	norm_id: string;
	topic_index: number;
	topic_label: string;
	headline: string;
	summary: string;
	article_count: number;
	block_ids: string;
};
const topics = db
	.query<TopicRow, []>(
		"SELECT norm_id, topic_index, topic_label, headline, summary, article_count, block_ids FROM omnibus_topics WHERE article_count = 0 OR summary = ''",
	)
	.all();
const emptyTopics = topics.filter(
	(t) =>
		t.summary.trim() === "" &&
		t.article_count === 0 &&
		(t.block_ids === "" || t.block_ids === "[]"),
);
const topicsToReview = topics.filter((t) => !emptyTopics.includes(t));

console.log(
	`a) reform_summaries.model 'qwen3.8-27b' → 'qwen/qwen3.8-27b': ${modelRows}`,
);
console.log(
	`b) article summaries to delete: ${secondPerson.length} in the second person, ${tooLong.length} over ${MAX_SUMMARY_CHARS} characters`,
);
for (const r of toDelete) {
	const words = (r.summary.match(SECOND_PERSON) ?? []).join(",");
	console.log(
		`   ${r.norm_id}/${r.block_id} (${r.summary.length}${words ? `; ${words}` : ""}): ${r.summary.slice(0, 100)}`,
	);
}
console.log(
	`   reform summaries in the second person (listed only; replaced by the batch reprocessing): ${reformsSecondPerson.length}`,
);
for (const r of reformsSecondPerson)
	console.log(
		`   ${r.norm_id}|${r.source_id}|${r.reform_date} [${r.model}]: ${r.headline}`,
	);
console.log(`c) empty omnibus topics to delete: ${emptyTopics.length}`);
for (const t of emptyTopics)
	console.log(`   ${t.norm_id} #${t.topic_index} ${t.topic_label}`);
console.log(
	`   topics with a summary but no articles (review, not touched): ${topicsToReview.length}`,
);
for (const t of topicsToReview)
	console.log(`   ${t.norm_id} #${t.topic_index} ${t.topic_label}`);

if (!apply) {
	console.log("\nDRY RUN: nothing written (use --apply --backup FILE)");
	process.exit(0);
}

const backup = {
	created_at: new Date().toISOString(),
	reform_model_renamed: modelRows,
	article_summaries: toDelete.map((r) => ({
		...r,
		tags: tagsOf.all(r.norm_id, r.block_id).map((t) => t.tag),
	})),
	omnibus_topics: emptyTopics,
};
await Bun.write(backupPath as string, JSON.stringify(backup, null, 1));
console.log(`\nbackup written: ${backupPath}`);

const deleteSummary = db.query(
	"DELETE FROM citizen_article_summaries WHERE norm_id = ? AND block_id = ?",
);
const deleteTags = db.query(
	"DELETE FROM citizen_tags WHERE norm_id = ? AND block_id = ?",
);
const deleteTopic = db.query(
	"DELETE FROM omnibus_topics WHERE norm_id = ? AND topic_index = ? AND summary = ''",
);
db.run("PRAGMA busy_timeout = 30000");
db.transaction(() => {
	db.run(
		"UPDATE reform_summaries SET model = 'qwen/qwen3.8-27b' WHERE model = 'qwen3.8-27b'",
	);
	for (const r of toDelete) {
		deleteSummary.run(r.norm_id, r.block_id);
		// Article-level tags only (block_id != ''); law tags are untouched.
		deleteTags.run(r.norm_id, r.block_id);
	}
	for (const t of emptyTopics) deleteTopic.run(t.norm_id, t.topic_index);
}).immediate();
console.log("APPLIED");
