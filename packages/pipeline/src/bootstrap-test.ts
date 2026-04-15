/**
 * Test bootstrap: download and commit ~100 laws from the BOE.
 *
 * Usage: bun run packages/pipeline/src/bootstrap-test.ts [limit]
 */

import { getCountry } from "./country.ts";
import { bootstrapFromApi } from "./pipeline.ts";

// Register Spain
import "./spain/index.ts";

const limit = Number(process.argv[2]) || 100;
const OUTPUT_DIR = process.env.REPO_PATH ?? "../leyes";
const DATA_DIR = "./data";

async function main() {
	const spain = getCountry("es");
	const client = spain.client();
	const textParser = spain.textParser();
	const metadataParser = spain.metadataParser();

	// Discover norm IDs
	console.log(`Discovering up to ${limit} norms from BOE...`);
	const normIds: string[] = [];
	for await (const id of spain.discovery().discoverAll(client)) {
		normIds.push(id as unknown as string);
		if (normIds.length >= limit) break;
	}
	console.log(`Found ${normIds.length} norms.\n`);

	let total = 0;
	let errors = 0;
	let skipped = 0;

	for (let i = 0; i < normIds.length; i++) {
		const normId = normIds[i]!;
		const progress = `[${i + 1}/${normIds.length}]`;

		try {
			const commits = await bootstrapFromApi(
				normId,
				client,
				textParser,
				metadataParser,
				{ repoPath: OUTPUT_DIR, dataDir: DATA_DIR },
			);

			if (commits === 0) {
				console.log(
					`${progress} ${normId} — skipped (no content or already committed)`,
				);
				skipped++;
			} else {
				console.log(`${progress} ${normId} — ${commits} commits`);
				total += commits;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`${progress} ${normId} — ERROR: ${msg}`);
			errors++;
		}
	}

	await client.close();

	console.log("\n─── Summary ───");
	console.log(`Norms processed: ${normIds.length}`);
	console.log(`Total commits:   ${total}`);
	console.log(`Skipped:         ${skipped}`);
	console.log(`Errors:          ${errors}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
