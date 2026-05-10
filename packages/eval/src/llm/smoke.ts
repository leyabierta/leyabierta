/**
 * Manual smoke test for the NaN client. Requires HERMES_API_KEY (NaN uses
 * HERMES_API_KEY per the existing convention in research/ab/eval-prod-replica.ts).
 *
 * Run: HERMES_API_KEY=... bun run packages/eval/src/llm/smoke.ts
 */

import { makeGemmaClient, makeQwenClient, startEvalTrace } from "./index.ts";

async function main() {
	const apiKey = process.env.HERMES_API_KEY;
	if (!apiKey) {
		console.log("[smoke] no HERMES_API_KEY, skipping");
		process.exit(0);
	}

	const trace = startEvalTrace("eval-smoke", { test: "nan-client" }, [
		"eval",
		"smoke",
	]);

	const qwen = makeQwenClient(apiKey, "smoke-qwen");
	const gemma = makeGemmaClient(apiKey, "smoke-gemma");

	const schema = {
		type: "object",
		properties: {
			ok: { type: "boolean" },
			message: { type: "string" },
		},
		required: ["ok", "message"],
		additionalProperties: false,
	} as const;

	console.log("[smoke] calling qwen3.6 ...");
	const a = await qwen.complete<{ ok: boolean; message: string }>({
		systemPrompt: "Devuelve SIEMPRE { ok: true, message: 'hola' }",
		userPrompt: "Responde con el JSON pedido.",
		jsonSchema: schema,
		jsonSchemaName: "smoke",
		temperature: 0,
		trace,
	});
	console.log(
		`  qwen ${a.tookMs}ms in=${a.tokensIn} out=${a.tokensOut}`,
		a.value,
	);

	console.log("[smoke] calling gemma4 ...");
	const b = await gemma.complete<{ ok: boolean; message: string }>({
		systemPrompt: "Devuelve SIEMPRE { ok: true, message: 'hola' }",
		userPrompt: "Responde con el JSON pedido.",
		jsonSchema: schema,
		jsonSchemaName: "smoke",
		temperature: 0,
		trace,
	});
	console.log(
		`  gemma ${b.tookMs}ms in=${b.tokensIn} out=${b.tokensOut}`,
		b.value,
	);

	trace.end({ qwen: a.value, gemma: b.value });
}

await main();
