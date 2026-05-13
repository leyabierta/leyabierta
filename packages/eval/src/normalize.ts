/**
 * Normalize raw datasets into unified QAEntry JSONL files.
 *
 * Usage:
 *   bun run packages/eval/src/normalize.ts --source <name> [--limit N] [--out PATH]
 *
 * Sources: dgt | sinai-cqa | refugiados | divorce | sinai-triplets | all
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { QAEntrySchema } from "./qa-schema.ts";
import { checkQuality } from "./quality.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const sourceArg = flag("source") ?? "all";
const limitArg = flag("limit") ? Number(flag("limit")) : undefined;
const outOverride = flag("out");

const DEFAULT_OUT_DIR = "/Volumes/Disco1TB/datasets/leyabierta/normalized";

type SourceName =
	| "dgt"
	| "sinai-cqa"
	| "refugiados"
	| "divorce"
	| "sinai-triplets";

const ALL_SOURCES: SourceName[] = [
	"dgt",
	"sinai-cqa",
	"refugiados",
	"divorce",
	"sinai-triplets",
];

function outPath(source: SourceName): string {
	if (outOverride) return outOverride;
	return `${DEFAULT_OUT_DIR}/${source}.jsonl`;
}

interface Summary {
	source: string;
	total_read: number;
	total_passed: number;
	total_failed: number;
	fail_reasons: Record<string, number>;
	output_path: string;
	finished_at: string;
}

async function runSource(source: SourceName): Promise<Summary> {
	console.log(`\n=== Normalizing: ${source} ===`);

	const path = outPath(source);
	mkdirSync(dirname(path), { recursive: true });

	let adapter: () => AsyncGenerator<import("./qa-schema.ts").QAEntry>;
	if (source === "dgt") {
		const mod = await import("./adapters/dgt.ts");
		adapter = mod.adapt;
	} else if (source === "sinai-cqa") {
		const mod = await import("./adapters/sinai-cqa.ts");
		adapter = mod.adapt;
	} else if (source === "refugiados") {
		const mod = await import("./adapters/refugiados.ts");
		adapter = mod.adapt;
	} else if (source === "divorce") {
		const mod = await import("./adapters/divorce.ts");
		adapter = mod.adapt;
	} else {
		const mod = await import("./adapters/sinai-triplets.ts");
		adapter = mod.adapt;
	}

	const failReasons: Record<string, number> = {};
	let totalRead = 0;
	let totalPassed = 0;
	let totalFailed = 0;

	// Stream output to avoid accumulating all entries in memory (important for large sources)
	const outStream = createWriteStream(path, { encoding: "utf8" });
	const writeLine = (line: string): Promise<void> =>
		new Promise((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			outStream.once("error", onError);
			const ok = outStream.write(`${line}\n`, (err) => {
				outStream.removeListener("error", onError);
				if (err) reject(err);
				else resolve();
			});
			// If write returns false, data is buffered — the write callback still fires
			// when the data is flushed. No separate drain listener needed.
			void ok;
		});

	for await (const entry of adapter()) {
		totalRead++;
		if (limitArg && totalPassed >= limitArg) break;

		// Validate against schema
		const parsed = QAEntrySchema.safeParse(entry);
		if (!parsed.success) {
			totalFailed++;
			const reason = "schema_validation_failed";
			failReasons[reason] = (failReasons[reason] ?? 0) + 1;
			continue;
		}

		const quality = checkQuality(parsed.data);
		if (!quality.pass) {
			totalFailed++;
			for (const r of quality.reasons) {
				failReasons[r] = (failReasons[r] ?? 0) + 1;
			}
			continue;
		}

		await writeLine(JSON.stringify(parsed.data));
		totalPassed++;

		if (totalRead % 5000 === 0) {
			console.log(
				`  [${source}] read=${totalRead} passed=${totalPassed} failed=${totalFailed}`,
			);
		}
	}

	await new Promise<void>((resolve, reject) => {
		outStream.end((err: Error | null | undefined) =>
			err ? reject(err) : resolve(),
		);
	});

	const summary: Summary = {
		source,
		total_read: totalRead,
		total_passed: totalPassed,
		total_failed: totalFailed,
		fail_reasons: failReasons,
		output_path: path,
		finished_at: new Date().toISOString(),
	};

	const summaryPath = path.replace(".jsonl", ".summary.json");
	await Bun.write(summaryPath, JSON.stringify(summary, null, 2));

	console.log(
		`  read=${totalRead} passed=${totalPassed} failed=${totalFailed}`,
	);
	console.log(`  Output: ${path}`);
	console.log(`  Summary: ${summaryPath}`);

	return summary;
}

const sources: SourceName[] =
	sourceArg === "all"
		? ALL_SOURCES
		: ALL_SOURCES.filter((s) => s === sourceArg);

if (sources.length === 0) {
	console.error(
		`Unknown source: ${sourceArg}. Valid: ${ALL_SOURCES.join(", ")}, all`,
	);
	process.exit(1);
}

for (const source of sources) {
	await runSource(source);
}

console.log("\nDone.");
