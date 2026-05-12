/**
 * Debug gemma4's JSON-schema-strict behavior via NaN.
 *
 * Runs a matrix of configurations (model × disableThinking × maxTokens) on
 * the same prompt that failed earlier and dumps the raw response to see
 * exactly what gemma4 emits vs qwen3.6.
 *
 * Usage: bun packages/api/research/ab/test-gemma-json-schema.ts
 */

const apiKey = process.env.HERMES_API_KEY;
if (!apiKey) throw new Error("HERMES_API_KEY required");

const URL = "https://api.nan.builders/v1/chat/completions";

const styleSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		style: {
			type: "string",
			enum: ["citizen", "professional", "corporate"],
		},
		topic: { type: "string" },
	},
	required: ["style", "topic"],
} as const;

const TEST_QUERY = `Conceptos retributivos que deben tenerse en cuenta a efectos de calcular la indemnización exenta por despido prevista en el artículo 7-e) de la Ley del IRPF`;

const SYS_PROMPT =
	"Clasifica el estilo de la consulta tributaria. `citizen` para una persona normal (pregunta concisa, lenguaje cotidiano, sin tecnicismos). `professional` para asesor/abogado/contable (jerga, referencias a artículos, sintaxis técnica). `corporate` para casos empresariales multi-párrafo con operaciones específicas.";

interface Cfg {
	label: string;
	model: string;
	disableThinking?: boolean;
	maxTokens: number;
	withSchema: boolean;
}

const cases: Cfg[] = [
	{
		label: "qwen3.6 / thinking=off / 300 tok / strict-schema",
		model: "qwen3.6",
		disableThinking: true,
		maxTokens: 300,
		withSchema: true,
	},
	{
		label: "gemma4 / no-thinking-flag / 100 tok / strict-schema",
		model: "gemma4",
		maxTokens: 100,
		withSchema: true,
	},
	{
		label: "gemma4 / no-thinking-flag / 300 tok / strict-schema",
		model: "gemma4",
		maxTokens: 300,
		withSchema: true,
	},
	{
		label: "gemma4 / no-thinking-flag / 1000 tok / strict-schema",
		model: "gemma4",
		maxTokens: 1000,
		withSchema: true,
	},
	{
		label: "gemma4 / thinking=off (explicit) / 1000 tok / strict-schema",
		model: "gemma4",
		disableThinking: true,
		maxTokens: 1000,
		withSchema: true,
	},
	{
		label: "gemma4 / thinking=on / 1000 tok / strict-schema",
		model: "gemma4",
		disableThinking: false,
		maxTokens: 1000,
		withSchema: true,
	},
	{
		label: "gemma4 / no-flag / 1000 tok / json_object",
		model: "gemma4",
		maxTokens: 1000,
		withSchema: false,
	},
	{
		label: "gemma4 / no-flag / 2000 tok / strict-schema",
		model: "gemma4",
		maxTokens: 2000,
		withSchema: true,
	},
];

async function run(cfg: Cfg): Promise<void> {
	const body: Record<string, unknown> = {
		model: cfg.model,
		messages: [
			{ role: "system", content: SYS_PROMPT },
			{ role: "user", content: TEST_QUERY },
		],
		temperature: 0.1,
		max_tokens: cfg.maxTokens,
	};
	if (cfg.withSchema) {
		body.response_format = {
			type: "json_schema",
			json_schema: { name: "style", strict: true, schema: styleSchema },
		};
	} else {
		body.response_format = { type: "json_object" };
	}
	if (cfg.disableThinking !== undefined) {
		body.chat_template_kwargs = { enable_thinking: !cfg.disableThinking };
	}

	const t0 = Date.now();
	const res = await fetch(URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const ms = Date.now() - t0;
	const raw = await res.text();
	console.log(`\n━━━ ${cfg.label} (${ms}ms, HTTP ${res.status}) ━━━`);
	try {
		const j = JSON.parse(raw);
		const msg = j.choices?.[0]?.message;
		const finish = j.choices?.[0]?.finish_reason;
		const usage = j.usage;
		const content = msg?.content ?? "";
		console.log(`  finish_reason: ${finish}`);
		console.log(
			`  usage: prompt=${usage?.prompt_tokens} completion=${usage?.completion_tokens} total=${usage?.total_tokens}`,
		);
		console.log(`  content (${content.length} chars):`);
		const preview =
			content.length > 600
				? `${content.slice(0, 600)}\n  …[${content.length - 600} more chars]`
				: content;
		console.log(
			preview
				.split("\n")
				.map((l: string) => `    ${l}`)
				.join("\n"),
		);
		// Try to parse the content as JSON
		try {
			const parsed = JSON.parse(content);
			console.log(`  parsed JSON OK: ${JSON.stringify(parsed)}`);
		} catch (err) {
			console.log(
				`  parse JSON FAILED: ${(err as Error).message.slice(0, 100)}`,
			);
		}
	} catch (_err) {
		console.log(`  raw (parse error): ${raw.slice(0, 600)}`);
	}
}

for (const c of cases) {
	try {
		await run(c);
	} catch (err) {
		console.log(`\n━━━ ${c.label} CRASHED: ${(err as Error).message} ━━━`);
	}
	await new Promise((r) => setTimeout(r, 500));
}
