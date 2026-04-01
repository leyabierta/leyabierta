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

			let loaded = 0;
			let errors = 0;
			for (const filePath of files) {
				try {
					const raw = await fs.readFile(filePath, "utf-8");
					const { data: frontmatter } = matter(raw);

					const id = relative(basePath, filePath).replace(/\.md$/, "");

					const data = await parseData({
						id,
						data: frontmatter,
					});

					store.set({ id, data, body: filePath });
					loaded++;
				} catch (err) {
					errors++;
					if (errors <= 3) {
						logger.warn(
							`Failed to load ${filePath}: ${err instanceof Error ? err.message : err}`,
						);
					}
				}
			}

			logger.info(`Loaded ${loaded} laws (${errors} errors)`);
		},
	};
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await findMarkdownFiles(fullPath)));
		} else if (entry.name.endsWith(".md")) {
			files.push(fullPath);
		}
	}

	return files;
}
