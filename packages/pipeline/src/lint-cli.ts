/**
 * CLI for the Markdown linter.
 *
 * Usage:
 *   bun run packages/pipeline/src/lint-cli.ts output/es/*.md
 *   bun run packages/pipeline/src/lint-cli.ts output/es/**\/*.md
 */

import { lintMarkdown } from "./transform/markdown-linter.ts";

async function main() {
	const patterns = process.argv.slice(2);
	if (patterns.length === 0) {
		console.log("Usage: bun run lint-cli.ts <glob-or-files...>");
		process.exit(1);
	}

	const files: string[] = [];
	for (const pattern of patterns) {
		const glob = new Bun.Glob(pattern);
		for await (const file of glob.scan(".")) {
			files.push(file);
		}
	}

	if (files.length === 0) {
		console.log("No files matched.");
		process.exit(0);
	}

	let totalErrors = 0;
	let totalWarnings = 0;
	let filesWithIssues = 0;

	for (const file of files.sort()) {
		const content = await Bun.file(file).text();
		const issues = lintMarkdown(content);

		if (issues.length === 0) continue;

		filesWithIssues++;
		console.log(`\n${file}:`);

		for (const issue of issues) {
			const icon = issue.severity === "error" ? "✖" : "⚠";
			console.log(
				`  ${icon} line ${issue.line}: [${issue.rule}] ${issue.message}`,
			);
			if (issue.severity === "error") totalErrors++;
			else totalWarnings++;
		}
	}

	console.log(`\n─── Lint Summary ───`);
	console.log(`Files checked:    ${files.length}`);
	console.log(`Files with issues: ${filesWithIssues}`);
	console.log(`Errors:           ${totalErrors}`);
	console.log(`Warnings:         ${totalWarnings}`);

	process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
