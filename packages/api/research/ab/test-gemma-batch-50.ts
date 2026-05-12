/**
 * Definitive A/B test for gemma4 vs qwen3.6 on real DGT batch queries.
 *
 * Tests fail-rate, latency, and output quality on 50 real consulta queries.
 * Configs:
 *   - gemma4 / max_tokens=100 / strict-schema / no thinking flag
 *   - gemma4 / max_tokens=150 / strict-schema / no thinking flag
 *   - qwen3.6 / max_tokens=300 / strict-schema / disable_thinking=true
 *
 * Usage: bun packages/api/research/ab/test-gemma-batch-50.ts
 */

const apiKey = process.env.HERMES_API_KEY;
if (!apiKey) throw new Error("HERMES_API_KEY required");

const URL = "https://api.nan.builders/v1/chat/completions";

const styleSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		style: { type: "string", enum: ["citizen", "professional", "corporate"] },
		topic: { type: "string" },
	},
	required: ["style", "topic"],
} as const;

const SYS = "Clasifica el estilo de la consulta tributaria. `citizen` para una persona normal (pregunta concisa, lenguaje cotidiano, sin tecnicismos). `professional` para asesor/abogado/contable (jerga, referencias a artículos, sintaxis técnica). `corporate` para casos empresariales multi-párrafo con operaciones específicas.";

// Load 50 real DGT consultas
const consultas = (await Bun.file("data/external/dgt-consultas.jsonl").text())
	.trim()
	.split("\n")
	.slice(0, 20)
	.map((l) => JSON.parse(l) as { cuestion: string; descripcion: string });

const queries = consultas.map((c) =>
	c.descripcion && c.descripcion.length > 30
		? `${c.descripcion}\n\nCuestión: ${c.cuestion}`
		: c.cuestion,
);

interface Cfg {
	label: string;
	model: string;
	disableThinking?: boolean;
	maxTokens: number;
}

async function runOne(cfg: Cfg, q: string): Promise<{
	ok: boolean;
	parsed?: { style: string; topic: string };
	error?: string;
	ms: number;
	completionTokens?: number;
	finishReason?: string;
	rawContentLen?: number;
}> {
	const body: Record<string, unknown> = {
		model: cfg.model,
		messages: [
			{ role: "system", content: SYS },
			{ role: "user", content: q },
		],
		temperature: 0.1,
		max_tokens: cfg.maxTokens,
		response_format: {
			type: "json_schema",
			json_schema: { name: "style", strict: true, schema: styleSchema },
		},
	};
	if (cfg.disableThinking !== undefined) {
		body.chat_template_kwargs = { enable_thinking: !cfg.disableThinking };
	}
	const t0 = Date.now();
	try {
		const res = await fetch(URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const ms = Date.now() - t0;
		if (!res.ok) {
			return { ok: false, error: `HTTP ${res.status}`, ms };
		}
		const j = await res.json();
		const content = j.choices?.[0]?.message?.content ?? "";
		const finish = j.choices?.[0]?.finish_reason;
		const completion = j.usage?.completion_tokens;
		try {
			const parsed = JSON.parse(content);
			return { ok: true, parsed, ms, completionTokens: completion, finishReason: finish, rawContentLen: content.length };
		} catch (err) {
			return {
				ok: false,
				error: `parse: ${(err as Error).message.slice(0, 80)}`,
				ms,
				completionTokens: completion,
				finishReason: finish,
				rawContentLen: content.length,
			};
		}
	} catch (err) {
		return { ok: false, error: `${(err as Error).message.slice(0, 80)}`, ms: Date.now() - t0 };
	}
}

async function runBatch(cfg: Cfg) {
	console.log(`\n=== ${cfg.label} ===`);
	const concurrency = 3;
	const results: Awaited<ReturnType<typeof runOne>>[] = new Array(queries.length);
	let idx = 0;
	await Promise.all(
		new Array(concurrency).fill(0).map(async () => {
			while (true) {
				const i = idx++;
				if (i >= queries.length) return;
				results[i] = await runOne(cfg, queries[i]!);
			}
		}),
	);
	const ok = results.filter((r) => r.ok);
	const fail = results.filter((r) => !r.ok);
	const okMs = ok.map((r) => r.ms).sort((a, b) => a - b);
	const p50 = okMs[Math.floor(okMs.length * 0.5)] ?? 0;
	const p95 = okMs[Math.floor(okMs.length * 0.95)] ?? 0;
	const avgTokens = ok.reduce((s, r) => s + (r.completionTokens ?? 0), 0) / Math.max(ok.length, 1);
	const finishLength = results.filter((r) => r.finishReason === "length").length;
	const maxContentLen = Math.max(...results.map((r) => r.rawContentLen ?? 0));
	console.log(`  Success: ${ok.length}/${results.length} (${(ok.length / results.length * 100).toFixed(0)}%)`);
	console.log(`  Failures: ${fail.length} — types: ${[...new Set(fail.map((r) => r.error?.slice(0, 30)))].join(" | ")}`);
	console.log(`  Latency p50=${p50}ms p95=${p95}ms`);
	console.log(`  Avg completion tokens: ${avgTokens.toFixed(0)}`);
	console.log(`  finish=length count: ${finishLength}`);
	console.log(`  Max content length: ${maxContentLen} chars`);
	if (ok.length > 0) {
		const styleHist: Record<string, number> = {};
		for (const r of ok) styleHist[r.parsed!.style] = (styleHist[r.parsed!.style] ?? 0) + 1;
		console.log(`  Style distribution:`, styleHist);
	}
}

await runBatch({ label: "gemma4 / 100 tok / no-thinking-flag", model: "gemma4", maxTokens: 100 });
await runBatch({ label: "gemma4 / 150 tok / no-thinking-flag", model: "gemma4", maxTokens: 150 });
await runBatch({ label: "gemma4 / 80 tok / no-thinking-flag", model: "gemma4", maxTokens: 80 });
await runBatch({ label: "qwen3.6 / 300 tok / disable-thinking", model: "qwen3.6", disableThinking: true, maxTokens: 300 });
