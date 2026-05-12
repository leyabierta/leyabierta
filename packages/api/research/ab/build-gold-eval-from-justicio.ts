/**
 * Build a gold-eval dataset from Dario López's Justicio HuggingFace datasets.
 *
 * Sources (all CC/Apache-2.0, BOE-A-anchored):
 *   - dariolopez/justicio-BOE-A-1978-31229-constitucion-by-articles-qa  (515 rows)
 *   - dariolopez/justicio-BOE-A-1889-4763-codigo-civil-64-chunks-qa     (64 rows)
 *   - dariolopez/justicio-BOE-A-2023-12203-vivienda-44-chunks-qa        (44 rows)
 *
 * Each row in source has {question, answer, context/content, ...}. We map to
 * our eval format `{id, question, expectedNorms, category, source}` where
 * `expectedNorms` is the single BOE-A ID encoded in the dataset slug.
 *
 * The HF "datasets-server" REST API serves rows paginated; we walk it.
 *
 * Usage:
 *   bun packages/api/research/ab/build-gold-eval-from-justicio.ts \
 *     [--out packages/api/research/datasets/gold-eval-justicio.json]
 */

import { isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
function resolvePath(p: string): string {
	return isAbsolute(p) ? p : join(repoRoot, p);
}

const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "packages/api/research/datasets/gold-eval-justicio.json");

const datasets = [
	{
		slug: "dariolopez/justicio-BOE-A-1978-31229-constitucion-by-articles-qa",
		boeId: "BOE-A-1978-31229",
		shortName: "constitucion",
		category: "Constitución Española",
	},
	{
		slug: "dariolopez/justicio-BOE-A-1889-4763-codigo-civil-64-chunks-qa",
		boeId: "BOE-A-1889-4763",
		shortName: "codigo-civil",
		category: "Código Civil",
	},
	{
		slug: "dariolopez/justicio-BOE-A-2023-12203-vivienda-44-chunks-qa",
		boeId: "BOE-A-2023-12203",
		shortName: "ley-vivienda",
		category: "Ley por el derecho a la vivienda",
	},
];

interface HfRow {
	row_idx: number;
	row: Record<string, unknown>;
}
interface HfResponse {
	rows: HfRow[];
	num_rows_total: number;
}

async function fetchAll(slug: string): Promise<HfRow[]> {
	const pageSize = 100;
	const all: HfRow[] = [];
	let offset = 0;
	while (true) {
		const url = new URL("https://datasets-server.huggingface.co/rows");
		url.searchParams.set("dataset", slug);
		url.searchParams.set("config", "default");
		url.searchParams.set("split", "train");
		url.searchParams.set("offset", String(offset));
		url.searchParams.set("length", String(pageSize));
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(`HF rows ${slug} ${res.status}: ${await res.text()}`);
		}
		const data = (await res.json()) as HfResponse;
		all.push(...data.rows);
		if (data.rows.length < pageSize) break;
		offset += pageSize;
		if (offset > data.num_rows_total) break;
	}
	return all;
}

function hashId(prefix: string, q: string): string {
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(q);
	return `${prefix}_${hasher.digest("hex").slice(0, 8)}`;
}

interface GoldEntry {
	id: string;
	question: string;
	expectedNorms: string[];
	category: string;
	source: {
		origin: "justicio-hf";
		dataset: string;
		article: string | number | null;
		answerSnippet: string;
	};
}

const combined: GoldEntry[] = [];
const seenQuestions = new Set<string>();

for (const ds of datasets) {
	console.log(`Fetching ${ds.slug}...`);
	const rows = await fetchAll(ds.slug);
	console.log(`  → ${rows.length} rows`);
	let kept = 0;
	let skippedDup = 0;
	for (const r of rows) {
		const question = String(r.row.question ?? "").trim();
		const answer = String(r.row.answer ?? "").trim();
		const articleNum =
			r.row.number !== undefined ? r.row.number : (r.row.id ?? null);
		if (!question || !answer) continue;
		const normalized = question.toLowerCase().replace(/\s+/g, " ").trim();
		if (seenQuestions.has(normalized)) {
			skippedDup++;
			continue;
		}
		seenQuestions.add(normalized);
		combined.push({
			id: hashId(`g-${ds.shortName}`, question),
			question,
			expectedNorms: [ds.boeId],
			category: ds.category,
			source: {
				origin: "justicio-hf",
				dataset: ds.slug,
				article: articleNum as string | number | null,
				answerSnippet: answer.slice(0, 300),
			},
		});
		kept++;
	}
	console.log(`  kept ${kept}, skipped dup ${skippedDup}`);
}

console.log(`\nTotal entries: ${combined.length}`);
console.log(`Distribution:`);
const byCat: Record<string, number> = {};
for (const e of combined) byCat[e.category] = (byCat[e.category] ?? 0) + 1;
for (const [c, n] of Object.entries(byCat)) console.log(`  ${c}: ${n}`);

await Bun.write(outPath, JSON.stringify({ results: combined }, null, 2));
console.log(`\nWrote → ${outPath}`);
