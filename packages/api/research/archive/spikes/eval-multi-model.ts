/**
 * Run full eval with multiple synthesis models.
 * Swaps the SYNTHESIS_MODEL constant in pipeline.ts, restarts the API,
 * runs the eval, and saves results for each model.
 *
 * Usage:
 *   bun run packages/api/research/eval-multi-model.ts
 */

import { join } from "node:path";
import { $ } from "bun";

const repoRoot = join(import.meta.dir, "../../../");
const pipelinePath = join(
	repoRoot,
	"packages/api/src/services/rag/pipeline.ts",
);

const MODELS = [
	"mistralai/ministral-8b-2512",
	"mistralai/mistral-small-2603",
	"qwen/qwen3-next-80b-a3b-instruct",
	"google/gemini-2.0-flash-001",
	"deepseek/deepseek-v4-flash",
];

// Save original file content
const originalContent = await Bun.file(pipelinePath).text();

async function setModel(model: string) {
	const content = await Bun.file(pipelinePath).text();
	const updated = content.replace(
		/const SYNTHESIS_MODEL = ".*?";/,
		`const SYNTHESIS_MODEL = "${model}";`,
	);
	await Bun.write(pipelinePath, updated);
}

async function restoreOriginal() {
	await Bun.write(pipelinePath, originalContent);
}

async function killApi() {
	try {
		await $`pkill -9 -f "bun.*api" 2>/dev/null || true`.quiet();
		await $`lsof -ti:3000 | xargs kill -9 2>/dev/null || true`.quiet();
	} catch {}
	await Bun.sleep(2000);
}

async function startApi(): Promise<boolean> {
	Bun.spawn(["bun", "run", "api"], {
		stdout: Bun.file("/tmp/leyabierta-api.log"),
		stderr: Bun.file("/tmp/leyabierta-api.log"),
	});
	// Wait for API to be ready
	for (let i = 0; i < 15; i++) {
		await Bun.sleep(2000);
		try {
			const res = await fetch("http://localhost:3000/health");
			if (res.ok) return true;
		} catch {}
	}
	return false;
}

async function runEval(outputPath: string) {
	const proc = Bun.spawn(
		[
			"bun",
			"run",
			"packages/api/research/eval-collect-answers.ts",
			"--output",
			outputPath,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	const code = await proc.exited;
	return code === 0;
}

// ── Main ──

console.log(
	`\nRunning eval with ${MODELS.length} models (65 questions each)\n`,
);

try {
	for (const model of MODELS) {
		const safeName = model.replace(/\//g, "_");
		const outputPath = join(repoRoot, "data", `eval-model-${safeName}.json`);

		console.log(`\n${"=".repeat(60)}`);
		console.log(`  Model: ${model}`);
		console.log(`  Output: ${outputPath}`);
		console.log("=".repeat(60));

		// Check if already done
		const existing = Bun.file(outputPath);
		if (await existing.exists()) {
			const data = await existing.json();
			if (data.results?.length >= 60) {
				console.log(
					`  ✓ Already done (${data.results.length} results), skipping`,
				);
				continue;
			}
		}

		// Swap model
		await setModel(model);
		console.log(`  Set SYNTHESIS_MODEL = "${model}"`);

		// Restart API
		await killApi();
		console.log("  Starting API...");
		const started = await startApi();
		if (!started) {
			console.log("  ✗ API failed to start, skipping");
			continue;
		}
		console.log("  ✓ API ready");

		// Run eval
		console.log("  Running eval...");
		const ok = await runEval(outputPath);
		if (!ok) {
			console.log("  ✗ Eval failed");
		}
	}
} finally {
	// Restore original
	await restoreOriginal();
	await killApi();
	console.log("\n✓ Restored original pipeline.ts and stopped API");
}

console.log("\nAll done. Results:");
for (const model of MODELS) {
	const safeName = model.replace(/\//g, "_");
	const path = join(repoRoot, "data", `eval-model-${safeName}.json`);
	const file = Bun.file(path);
	if (await file.exists()) {
		const data = await file.json();
		console.log(`  ${model}: ${data.results?.length ?? 0} results`);
	} else {
		console.log(`  ${model}: MISSING`);
	}
}
