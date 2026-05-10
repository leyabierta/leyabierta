/**
 * CLI for the eval dataset pipeline.
 *
 * Subcommands:
 *   import             read citizen-queries.json + unique eval-answers-*.json
 *                      and write packages/eval/datasets/seeds/v3-seeds.json
 *   generate --pilot   run the agentic pipeline for 20 questions
 *   generate --target N
 *   review-borderline  TUI for human review of the borderline queue
 *   split              produce train/val/test (disjoint by norm)
 *
 * NOT YET IMPLEMENTED — this is a scaffold to lock the surface area before
 * we wire NaN. Each subcommand prints a clear "not implemented yet" with a
 * pointer to the PLAN doc.
 */

import { runImport } from "./importers/index.ts";

const PLAN = "packages/eval/docs/PLAN-DATASET-GEN-2026-05-10.md";

function usage(): never {
	console.log(`@leyabierta/eval CLI

Usage: bun run packages/eval/src/cli.ts <command> [flags]

Commands:
  import                    Import 114 human seed questions to v3 schema
  generate --pilot          Run pilot of 20 questions (calibration)
  generate --target N       Run full pipeline targeting N accepted questions
  review-borderline         Human review of the borderline queue
  split                     Emit train/val/test (disjoint by norm)

See ${PLAN} for the full design.`);
	process.exit(1);
}

async function main() {
	const [, , cmd, ...rest] = process.argv;
	switch (cmd) {
		case "import": {
			const { dataset, outAbsPath } = await runImport();
			console.log(`Wrote ${outAbsPath}`);
			console.log(JSON.stringify(dataset.meta, null, 2));
			break;
		}
		case "generate":
		case "review-borderline":
		case "split":
			console.error(
				`[${cmd}] not implemented yet. See ${PLAN} for the plan and ` +
					`packages/eval/src/{pipeline,agents,sampling,importers}/.`,
			);
			process.exit(2);
			break;
		default:
			usage();
	}
	void rest;
}

await main();
