/**
 * LLM-enrich the DGT consultas data (output of scrape-dgt-consultas.ts) using
 * NaN's gemma4 with strict JSON schema. Two passes:
 *
 *   1. **Recovery pass** over the unmapped subset (those whose `normativa`
 *      regex didn't yield any BOE-A-ID, typically because they cite derogated
 *      laws or use abbreviations like TRLRHL, LGT, RIVA, RDLeg).
 *      The model is asked to:
 *        - expand abbreviations to full law names (e.g. "TRLRHL" → "Real
 *          Decreto Legislativo 2/2004"),
 *        - propose the *currently vigente equivalent* if the cited law has
 *          been replaced (e.g. "Ley 40/1998 IRPF" → "Ley 35/2006 IRPF").
 *
 *   2. **Style classification** over all consultas to mark each as
 *      `citizen` (a plain-language consumer question), `professional` (an
 *      accountant/lawyer-style technical question), or `corporate` (a
 *      multi-paragraph business operation). We'll later prefer `citizen`
 *      and downsample `corporate` for the gold eval.
 *
 * Both passes resolve any proposed law names against the local `norms` DB to
 * verify the BOE-A-ID exists. Hallucinations are dropped.
 *
 * Usage:
 *   bun packages/api/research/ab/llm-enrich-dgt.ts \
 *     [--in  data/external/dgt-consultas.jsonl] \
 *     [--unmapped data/external/dgt-unmapped.jsonl] \
 *     [--out packages/api/research/datasets/gold-eval-dgt-enriched.json] \
 *     [--concurrency 3]
 */

import { Database } from "bun:sqlite";
import { isAbsolute, join } from "node:path";
import { callNan } from "../../../api/src/services/nan.ts";
import type { OpenRouterMessage } from "../../../api/src/services/openrouter.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
function resolvePath(p: string): string {
	return isAbsolute(p) ? p : join(repoRoot, p);
}

const inPath = flag("in")
	? resolvePath(flag("in")!)
	: join(repoRoot, "data/external/dgt-consultas.jsonl");
const unmappedPath = flag("unmapped")
	? resolvePath(flag("unmapped")!)
	: join(repoRoot, "data/external/dgt-unmapped.jsonl");
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(
			repoRoot,
			"packages/api/research/datasets/gold-eval-dgt-enriched.json",
		);
const concurrency = Number(flag("concurrency") ?? "3");

const apiKey = process.env.HERMES_API_KEY;
if (!apiKey) throw new Error("HERMES_API_KEY env var required");

const db = new Database(join(repoRoot, "data/leyabierta.db"), {
	readonly: true,
});

// ── Step 0: load raw consultas + mapped gold + unmapped list ──

interface Consulta {
	docId: string;
	numConsulta: string;
	organo: string;
	fechaSalida: string;
	normativa: string;
	cuestion: string;
	descripcion: string;
	contestacion: string;
}

const allConsultas = (await Bun.file(inPath).text())
	.trim()
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Consulta);

const unmappedRefs = (await Bun.file(unmappedPath).text())
	.trim()
	.split("\n")
	.filter((l) => l.trim())
	.map(
		(l) =>
			JSON.parse(l) as {
				docId: string;
				numConsulta: string;
				normativa: string;
			},
	);
const unmappedIds = new Set(unmappedRefs.map((u) => u.docId));

console.log(
	`Loaded ${allConsultas.length} consultas, ${unmappedIds.size} unmapped`,
);

// ── DB lookup helpers ──

const lookupById = db.query<{ id: string }, [string]>(
	"SELECT id FROM norms WHERE id = ?",
);
const lookupByTitle = db.query<
	{ id: string; status: string; title: string },
	[string]
>(
	"SELECT id, status, substr(title, 1, 200) as title FROM norms WHERE title LIKE ? ORDER BY (status = 'vigente') DESC LIMIT 3",
);

function _verifyNormId(id: string): boolean {
	return lookupById.get(id) !== null;
}

function findByLawName(name: string): string | null {
	// Try title-prefix LIKE search. The model proposes names like
	// "Ley 35/2006" or "Real Decreto Legislativo 2/2004".
	const rows = lookupByTitle.all(`${name}%`);
	if (rows.length === 0) return null;
	const vigente = rows.find((r) => r.status === "vigente");
	return vigente?.id ?? rows[0]!.id;
}

// ── Step 1: recovery pass on the 33 unmapped ──

const recoverySchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		expanded_citations: {
			type: "array",
			description:
				"For each law citation in the input `normativa` string, produce a full canonical Spanish law name. If the cited law has been DEROGADA (repealed) and replaced by a vigente equivalent on the same topic, also produce the equivalent.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					original: {
						type: "string",
						description:
							"Substring from the input that this citation expands. Verbatim.",
					},
					canonical_name: {
						type: "string",
						description:
							"Full Spanish law name without article references. e.g. 'Real Decreto Legislativo 2/2004' or 'Ley 58/2003'.",
					},
					vigente_equivalent: {
						type: "string",
						description:
							"If the cited law is derogada and has a known vigente equivalent (same topic, e.g. IRPF, IVA), the canonical name of the current law. Otherwise repeat canonical_name.",
					},
				},
				required: ["original", "canonical_name", "vigente_equivalent"],
			},
		},
	},
	required: ["expanded_citations"],
} as const;

interface RecoveryResult {
	expanded_citations: Array<{
		original: string;
		canonical_name: string;
		vigente_equivalent: string;
	}>;
}

async function recoverConsulta(c: Consulta): Promise<{
	docId: string;
	mappedNorms: string[];
	canonicalNames: string[];
	rawProposals: RecoveryResult["expanded_citations"];
}> {
	const messages: OpenRouterMessage[] = [
		{
			role: "system",
			content:
				"Eres un experto en derecho español. Tu tarea es interpretar referencias normativas en consultas tributarias y devolverlas en formato canónico, expandiendo abreviaturas (TRLRHL, LGT, RIVA, etc.) y mapeando leyes derogadas a su equivalente vigente actual cuando aplique. Si una ley ha sido derogada y existe una norma vigente sobre el mismo impuesto/materia, propón la vigente. Solo emite leyes españolas reales del BOE.",
		},
		{
			role: "user",
			content: `Consulta DGT ${c.numConsulta} (${c.fechaSalida}). Órgano: ${c.organo}.

Normativa citada en el documento original:
"""
${c.normativa}
"""

Para cada referencia a una ley, real decreto, real decreto-ley, real decreto legislativo o ley orgánica que detectes en el texto anterior, expándela a su forma canónica y propón equivalente vigente si es derogada. Devuelve solo las que sepas con certeza.`,
		},
	];

	const res = await callNan<RecoveryResult>(apiKey!, {
		model: "qwen3.6",
		messages,
		temperature: 0.1,
		maxTokens: 1200,
		jsonSchema: { name: "recovery", schema: recoverySchema },
	});

	const proposals = res.data.expanded_citations;
	const mapped = new Set<string>();
	const canonNames = new Set<string>();
	for (const p of proposals) {
		canonNames.add(p.canonical_name);
		// Try the vigente_equivalent first (preferred), then canonical_name.
		for (const name of [p.vigente_equivalent, p.canonical_name]) {
			if (!name) continue;
			const id = findByLawName(name);
			if (id) {
				mapped.add(id);
				break;
			}
		}
	}
	return {
		docId: c.docId,
		mappedNorms: [...mapped],
		canonicalNames: [...canonNames],
		rawProposals: proposals,
	};
}

// ── Step 2: style classification on all consultas ──

const styleSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		style: {
			type: "string",
			enum: ["citizen", "professional", "corporate"],
			description:
				"`citizen` = plain-language consumer question (would be asked by a regular person). `professional` = tax-advisor/accountant style with technical jargon. `corporate` = multi-paragraph business operation description.",
		},
		topic: {
			type: "string",
			description:
				"Short topic label, 2-4 words. e.g. 'IVA cesión local', 'IRPF indemnización despido'.",
		},
	},
	required: ["style", "topic"],
} as const;

interface StyleResult {
	style: "citizen" | "professional" | "corporate";
	topic: string;
}

async function classifyStyle(c: Consulta): Promise<StyleResult> {
	const queryText =
		c.descripcion && c.descripcion.length > 30
			? `${c.descripcion}\n\nCuestión: ${c.cuestion}`
			: c.cuestion;
	const messages: OpenRouterMessage[] = [
		{
			role: "system",
			content:
				"Clasifica el estilo de la consulta tributaria. `citizen` para una persona normal (pregunta concisa, lenguaje cotidiano, sin tecnicismos). `professional` para asesor/abogado/contable (jerga, referencias a artículos, sintaxis técnica). `corporate` para casos empresariales multi-párrafo con operaciones específicas.",
		},
		{ role: "user", content: queryText },
	];
	const res = await callNan<StyleResult>(apiKey!, {
		model: "qwen3.6",
		messages,
		temperature: 0.1,
		maxTokens: 300,
		jsonSchema: { name: "style", schema: styleSchema },
	});
	return res.data;
}

// ── Parallel runner ──

async function runParallel<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	concurrencyLevel: number,
	label = "",
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let idx = 0;
	const workers = new Array(concurrencyLevel).fill(0).map(async () => {
		while (true) {
			const i = idx++;
			if (i >= items.length) return;
			try {
				results[i] = await fn(items[i]!);
				if ((i + 1) % 10 === 0 || i === items.length - 1) {
					console.log(`  ${label} ${i + 1}/${items.length}`);
				}
			} catch (err) {
				console.error(
					`  ${label} item ${i} FAILED: ${err instanceof Error ? err.message : String(err)}`,
				);
				results[i] = undefined as unknown as R;
			}
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Run recovery pass ──

const unmappedConsultas = allConsultas.filter((c) => unmappedIds.has(c.docId));
console.log(
	`\n=== Pass 1: LLM recovery on ${unmappedConsultas.length} unmapped consultas ===`,
);
const recoveryResults = await runParallel(
	unmappedConsultas,
	recoverConsulta,
	concurrency,
	"recovery",
);

let recoveredCount = 0;
const recoveryByDocId = new Map<string, (typeof recoveryResults)[number]>();
for (const r of recoveryResults) {
	if (!r) continue;
	recoveryByDocId.set(r.docId, r);
	if (r.mappedNorms.length > 0) recoveredCount++;
}
console.log(
	`Recovery pass: ${recoveredCount}/${unmappedConsultas.length} consultas recovered`,
);

// ── Run style classification on all ──

console.log(
	`\n=== Pass 2: style classification on all ${allConsultas.length} ===`,
);
const styleResults = await runParallel(
	allConsultas,
	classifyStyle,
	concurrency,
	"style",
);
const styleByDocId = new Map<string, StyleResult>();
for (let i = 0; i < allConsultas.length; i++) {
	if (styleResults[i])
		styleByDocId.set(allConsultas[i]!.docId, styleResults[i]!);
}

const styleHist: Record<string, number> = {};
for (const s of styleByDocId.values()) {
	styleHist[s.style] = (styleHist[s.style] ?? 0) + 1;
}
console.log(`Style distribution:`);
for (const [s, n] of Object.entries(styleHist)) console.log(`  ${s}: ${n}`);

// ── Build enriched gold output ──

interface EnrichedEntry {
	id: string;
	question: string;
	expectedNorms: string[];
	category: string;
	style: "citizen" | "professional" | "corporate" | "unknown";
	topic: string;
	source: {
		origin: "dgt-consulta";
		numConsulta: string;
		fechaSalida: string;
		organo: string;
		rawNormativa: string;
		mappingMethod: "regex" | "llm-recovery";
		llmProposals?: RecoveryResult["expanded_citations"];
		descripcion: string;
		contestacionSnippet: string;
	};
}

function hashId(q: string): string {
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(q);
	return `qd_${hasher.digest("hex").slice(0, 8)}`;
}

// Re-derive regex mapping (same logic as map-dgt-to-gold.ts) so we have one
// authoritative output file.
const regexPatterns = [
	{
		kind: "Ley Orgánica",
		re: /(?:Ley Org[áa]nica|L\.?\s*O\.?|LO)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Real Decreto Legislativo",
		re: /(?:Real Decreto Legislativo|R\.?D\.?\s*Leg(?:islativo)?\.?|RD Leg|RDLeg)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Real Decreto-Ley",
		re: /(?:Real Decreto-?\s*[Ll]ey|R\.?D\.?-?\s*[Ll]ey|RD-?L)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Real Decreto",
		re: /(?:Real Decreto|R\.?D\.?)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{ kind: "Ley Foral", re: /Ley Foral\s+(\d+)\/((?:19|20)\d{2})/g },
	{ kind: "Ley", re: /Ley\s+(\d+)\/((?:19|20)\d{2})/g },
];

function regexMap(normativa: string): string[] {
	const claimed = new Set<string>();
	const ids = new Set<string>();
	for (const { kind, re } of regexPatterns) {
		for (const m of normativa.matchAll(re)) {
			let overlap = false;
			for (const c of claimed) {
				const [pos, len] = c.split("-").map(Number);
				if (m.index! >= pos! && m.index! < pos! + len!) {
					overlap = true;
					break;
				}
			}
			if (overlap) continue;
			claimed.add(`${m.index}-${m[0]!.length}`);
			const id = findByLawName(`${kind} ${m[1]}/${m[2]}`);
			if (id) ids.add(id);
		}
	}
	return [...ids];
}

const enriched: EnrichedEntry[] = [];

for (const c of allConsultas) {
	const fromRegex = regexMap(c.normativa);
	const fromLlm = recoveryByDocId.get(c.docId)?.mappedNorms ?? [];
	const expectedNorms = [...new Set([...fromRegex, ...fromLlm])];
	if (expectedNorms.length === 0) continue;

	let question = c.cuestion;
	if (
		c.descripcion &&
		c.descripcion.length > 30 &&
		c.descripcion.length < 300
	) {
		question = `${c.descripcion} ${c.cuestion}`;
	}

	const style = styleByDocId.get(c.docId);
	enriched.push({
		id: hashId(question),
		question,
		expectedNorms,
		category: c.organo,
		style: style?.style ?? "unknown",
		topic: style?.topic ?? "",
		source: {
			origin: "dgt-consulta",
			numConsulta: c.numConsulta,
			fechaSalida: c.fechaSalida,
			organo: c.organo,
			rawNormativa: c.normativa,
			mappingMethod: fromRegex.length > 0 ? "regex" : "llm-recovery",
			llmProposals: recoveryByDocId.get(c.docId)?.rawProposals,
			descripcion: c.descripcion,
			contestacionSnippet: c.contestacion.slice(0, 300),
		},
	});
}

console.log(`\n=== Final enriched gold ===`);
console.log(`Total entries: ${enriched.length}`);
const byMethod: Record<string, number> = {};
const byStyle: Record<string, number> = {};
for (const e of enriched) {
	byMethod[e.source.mappingMethod] =
		(byMethod[e.source.mappingMethod] ?? 0) + 1;
	byStyle[e.style] = (byStyle[e.style] ?? 0) + 1;
}
console.log(`By mapping method:`, byMethod);
console.log(`By style:`, byStyle);

await Bun.write(outPath, JSON.stringify({ results: enriched }, null, 2));
console.log(`\nWrote → ${outPath}`);
