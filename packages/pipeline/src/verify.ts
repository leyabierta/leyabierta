/**
 * Verify our pipeline output against the Legalize API.
 *
 * Compares: metadata, reform count/dates, article count, and article text.
 *
 * Usage: bun run packages/pipeline/src/verify.ts
 */

const LEGALIZE_BASE = "https://legalize.dev/api/v1/es";
const DATA_DIR = "./data/json";

interface LegalizeReform {
	date: string;
	source_id: string;
	articles_affected: string;
}

interface LegalizeArticle {
	block_id: string;
	block_type: string;
	title: string;
	position: number;
	current_text: string;
}

interface LegalizeLaw {
	id: string;
	titulo: string;
	rango: string;
	fecha_publicacion: string;
	estado: string;
	article_count: number;
	articles?: LegalizeArticle[];
	articles_total?: number;
}

async function fetchLegalize(path: string): Promise<unknown> {
	const res = await fetch(`${LEGALIZE_BASE}${path}`, {
		headers: { Accept: "application/json" },
	});
	if (!res.ok) return null;
	return res.json();
}

function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function diffSnippet(ours: string, theirs: string): string {
	const a = normalize(ours);
	const b = normalize(theirs);

	// Find first divergence point
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;

	const start = Math.max(0, i - 30);
	const oursSnip = a.slice(start, i + 50);
	const theirsSnip = b.slice(start, i + 50);

	return `at char ${i}: ours="...${oursSnip}..." theirs="...${theirsSnip}..."`;
}

async function verify() {
	const glob = new Bun.Glob("*.json");
	const files: string[] = [];
	for await (const file of glob.scan(DATA_DIR)) {
		files.push(file);
	}

	console.log(`Found ${files.length} norms to check against Legalize.\n`);

	let checked = 0;
	let matched = 0;
	let mismatched = 0;
	let notInLegalize = 0;
	let totalArticlesCompared = 0;
	let articleTextMatches = 0;
	let articleTextMismatches = 0;
	const issues: string[] = [];

	for (const file of files) {
		const normId = file.replace(".json", "");
		const ourData = await Bun.file(`${DATA_DIR}/${file}`).json();

		// Fetch law with ALL articles for text comparison
		const articleCount = ourData.articles.length;
		const theirLaw = (await fetchLegalize(
			`/laws/${normId}?include_articles=true&articles_limit=${articleCount}`,
		)) as LegalizeLaw | null;

		if (!theirLaw || !("id" in theirLaw)) {
			notInLegalize++;
			continue;
		}

		checked++;
		const problems: string[] = [];

		// 1. Compare publish date
		if (ourData.metadata.published !== theirLaw.fecha_publicacion) {
			problems.push(
				`publish date: ours=${ourData.metadata.published} theirs=${theirLaw.fecha_publicacion}`,
			);
		}

		// 2. Compare rank
		if (ourData.metadata.rank !== theirLaw.rango) {
			problems.push(
				`rank: ours=${ourData.metadata.rank} theirs=${theirLaw.rango}`,
			);
		}

		// 3. Compare article count
		if (articleCount !== theirLaw.article_count) {
			problems.push(
				`articles: ours=${articleCount} theirs=${theirLaw.article_count}`,
			);
		}

		// 4. Compare reforms
		const theirReforms = (await fetchLegalize(
			`/laws/${normId}/reforms?limit=1000`,
		)) as { reforms: LegalizeReform[]; total: number } | null;

		if (theirReforms) {
			if (ourData.reforms.length !== theirReforms.total) {
				problems.push(
					`reforms: ours=${ourData.reforms.length} theirs=${theirReforms.total}`,
				);
			}

			const ourDates = new Set(
				ourData.reforms.map((r: { date: string }) => r.date),
			);
			const theirDates = new Set(
				theirReforms.reforms.map((r: LegalizeReform) => r.date),
			);

			const missing = [...theirDates].filter((d) => !ourDates.has(d));
			const extra = [...ourDates].filter((d) => !theirDates.has(d as string));

			if (missing.length > 0) {
				problems.push(`missing reform dates: ${missing.join(", ")}`);
			}
			if (extra.length > 0) {
				problems.push(`extra reform dates: ${extra.join(", ")}`);
			}
		}

		// 5. Compare article text content
		if (theirLaw.articles && theirLaw.articles.length > 0) {
			const theirByBlockId = new Map(
				theirLaw.articles.map((a) => [a.block_id, a]),
			);

			let textIssuesForNorm = 0;
			for (const ourArt of ourData.articles) {
				const theirArt = theirByBlockId.get(ourArt.blockId);
				if (!theirArt) continue;

				totalArticlesCompared++;
				const ourText = normalize(ourArt.currentText);
				const theirText = normalize(theirArt.current_text);

				if (ourText === theirText) {
					articleTextMatches++;
				} else {
					articleTextMismatches++;
					textIssuesForNorm++;
					if (textIssuesForNorm <= 2) {
						problems.push(
							`text mismatch [${ourArt.blockId}]: ${diffSnippet(ourArt.currentText, theirArt.current_text)}`,
						);
					}
				}
			}
			if (textIssuesForNorm > 2) {
				problems.push(`... and ${textIssuesForNorm - 2} more text mismatches`);
			}
		}

		if (problems.length === 0) {
			console.log(`  ✅ ${normId}`);
			matched++;
		} else {
			console.log(`  ❌ ${normId}:`);
			for (const p of problems) {
				console.log(`     ${p}`);
			}
			issues.push(`${normId}: ${problems.join("; ")}`);
			mismatched++;
		}

		await new Promise((r) => setTimeout(r, 200));
	}

	console.log("\n─── Verification Summary ───");
	console.log(`Checked against Legalize: ${checked}`);
	console.log(`Matched (all fields):     ${matched}`);
	console.log(`Mismatched:               ${mismatched}`);
	console.log(`Not in Legalize:          ${notInLegalize}`);
	console.log(
		`Match rate:               ${checked > 0 ? ((matched / checked) * 100).toFixed(1) : 0}%`,
	);
	console.log("");
	console.log(`─── Text Comparison ───`);
	console.log(`Articles compared:        ${totalArticlesCompared}`);
	console.log(`Text matches:             ${articleTextMatches}`);
	console.log(`Text mismatches:          ${articleTextMismatches}`);
	console.log(
		`Text match rate:          ${totalArticlesCompared > 0 ? ((articleTextMatches / totalArticlesCompared) * 100).toFixed(1) : 0}%`,
	);

	if (issues.length > 0) {
		console.log("\n─── All Issues ───");
		for (const issue of issues) {
			console.log(`  ${issue}`);
		}
	}
}

verify().catch(console.error);
