/**
 * Custom content loader that reads only YAML frontmatter from law files.
 *
 * The built-in glob loader parses the entire markdown body of every file,
 * which is prohibitively slow for 12K+ law files (370MB of text).
 * This loader uses gray-matter to extract only the frontmatter, making
 * content sync ~100x faster. The markdown body is read and rendered
 * on-demand per page in [id].astro instead.
 */

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import type { Loader } from "astro/loaders";
import matter from "gray-matter";

export function lawsLoader(options: { path: string }): Loader {
	return {
		name: "laws-loader",
		async load({ store, parseData, logger }) {
			const basePath = options.path;

			logger.info(`Scanning ${basePath} for .md files...`);
			const files = await findMarkdownFiles(basePath);
			logger.info(`Found ${files.length} law files`);

			store.clear();

			const results = await Promise.all(
				files.map(async (filePath) => {
					try {
						const raw = await fs.readFile(filePath, "utf-8");
						const { data: frontmatter } = matter(raw);

						const id = relative(basePath, filePath).replace(/\.md$/, "");

						const data = await parseData({
							id,
							data: frontmatter,
						});

						return { success: true, id, data, filePath };
					} catch (err) {
						return { success: false, filePath, error: err };
					}
				}),
			);

			let loaded = 0;
			let errors = 0;
			for (const result of results) {
				if (result.success) {
					store.set({ id: result.id!, data: result.data!, body: result.filePath! });
					loaded++;
				} else {
					errors++;
					if (errors <= 3) {
						logger.warn(
							`Failed to load ${result.filePath}: ${result.error instanceof Error ? result.error.message : result.error}`,
						);
					}
				}
			}

			logger.info(`Loaded ${loaded} laws (${errors} errors)`);
		},
	};
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });

	const results = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				return findMarkdownFiles(fullPath);
			}
			if (entry.name.endsWith(".md")) {
				return [fullPath];
			}
			return [] as string[];
		}),
	);

	return results.flat();
}
