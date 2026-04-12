/**
 * Spike: LLM extraction as VERIFICATION layer for the bill parser.
 *
 * Approach 4: full-document LLM extraction with structured output.
 * Send each bill's text to Gemini 2.5 Flash Lite and ask it to list ALL
 * modification groups, then compare against what our regex parser found.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-llm-verification.ts
 */

import { callOpenRouter } from "../services/openrouter.ts";
import {
	extractTextFromPdf,
	parseBill,
	type ModificationGroup,
} from "../services/bill-parser/parser.ts";

const MODEL = "google/gemini-2.5-flash-lite";
const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
	console.error("Set OPENROUTER_API_KEY");
	process.exit(1);
}

// ── Bills to test ──

const BILLS = [
	{
		pdf: "./data/spike-bills/BOCG-14-A-62-1.PDF",
		name: "Solo sí es sí (14 DFs, ground truth)",
		id: "BOCG-14-A-62-1",
	},
	{
		pdf: "./data/spike-bills/BOCG-15-B-23-1.PDF",
		name: "Deepfakes (7 artículos, we find 6)",
		id: "BOCG-15-B-23-1",
	},
	{
		pdf: "./data/spike-bills/BOCG-15-A-3-1.PDF",
		name: "Omnibus (46 groups, complex)",
		id: "BOCG-15-A-3-1",
	},
	{
		pdf: "./data/spike-bills/BOCG-15-B-32-1.PDF",
		name: "Amnistía (mods in DAs)",
		id: "BOCG-15-B-32-1",
	},
	{
		pdf: "./data/spike-bills/BOCG-15-B-40-1.PDF",
		name: "Numeric ordinals",
		id: "BOCG-15-B-40-1",
	},
];

// ── LLM schema ──

interface LLMModGroup {
	target_law: string;
	section_type: string;
	estimated_modifications: number;
}

interface LLMResponse {
	modification_groups: LLMModGroup[];
}

const JSON_SCHEMA = {
	type: "object" as const,
	properties: {
		modification_groups: {
			type: "array" as const,
			items: {
				type: "object" as const,
				properties: {
					target_law: {
						type: "string" as const,
						description:
							"Name of the law being modified (e.g., 'Código Penal', 'Ley de Enjuiciamiento Criminal')",
					},
					section_type: {
						type: "string" as const,
						description:
							"Type of section: DF (disposición final), DA (disposición adicional), DT (disposición transitoria), artículo, artículo único",
					},
					estimated_modifications: {
						type: "number" as const,
						description:
							"Estimated number of individual modifications (articles/apartados changed) in this group",
					},
				},
				required: [
					"target_law",
					"section_type",
					"estimated_modifications",
				] as const,
				additionalProperties: false,
			},
		},
	},
	required: ["modification_groups"] as const,
	additionalProperties: false,
};

// ── Extract skeleton for large bills ──

function extractSkeleton(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	const patterns = [
		/^Artículo/i,
		/^Disposición/i,
		/Se modifica/i,
		/Modificación/i,
		/queda(?:n)?\s+redactad/i,
		/Se añade/i,
		/Se suprime/i,
		/Se deroga/i,
		/Se introduce/i,
		/nueva redacción/i,
		/^Uno\./,
		/^Dos\./,
		/^Tres\./,
		/^Cuatro\./,
		/^Cinco\./,
		/^Primero\./,
		/^Segundo\./,
		/^Tercero\./,
	];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (patterns.some((p) => p.test(line))) {
			// Keep the line + 1 line of context after
			kept.push(line);
			if (i + 1 < lines.length) {
				kept.push(lines[i + 1]!);
			}
			kept.push(""); // separator
		}
	}

	return kept.join("\n");
}

// ── LLM call ──

async function llmExtractGroups(text: string): Promise<{
	groups: LLMModGroup[];
	cost: number;
	tokensIn: number;
	tokensOut: number;
}> {
	// For large bills, extract skeleton; for small ones, send full text
	let content: string;
	if (text.length > 30_000) {
		const skeleton = extractSkeleton(text);
		content = skeleton.slice(0, 60_000); // safety cap
	} else {
		content = text;
	}

	const systemPrompt = `You are a Spanish legislative analyst. Given a bill (proyecto/proposición de ley) published in the BOCG, list ALL laws that this bill modifies.

Look for:
- Disposiciones finales (DF) that modify other laws ("Modificación de la Ley...", "Se modifica el artículo X de la Ley...")
- Disposiciones adicionales (DA) that modify other laws
- Artículos (numbered or "artículo único") that modify other laws
- Any section that contains "Se modifica", "queda redactado", "Se añade", "Se suprime", "Se deroga" referencing another law

For each modification group, identify:
1. The target law being modified (use its common name or official title)
2. The section type in the bill (DF, DA, DT, artículo, artículo único)
3. Estimated number of individual modifications (how many articles/apartados are changed)

Be thorough. Do NOT miss any law that is modified. Include even minor modifications in disposiciones adicionales or transitorias.
Do NOT include the bill itself — only laws it modifies.
Do NOT include laws that are merely referenced or cited without being modified.`;

	const result = await callOpenRouter<LLMResponse>(apiKey!, {
		model: MODEL,
		messages: [
			{ role: "system", content: systemPrompt },
			{
				role: "user",
				content: `Here is the bill text${text.length > 30_000 ? " (structural skeleton — headers and modification lines only)" : ""}:\n\n${content}`,
			},
		],
		temperature: 0.1,
		maxTokens: 4000,
		jsonSchema: { name: "bill_modifications", schema: JSON_SCHEMA },
	});

	return {
		groups: result.data.modification_groups,
		cost: result.cost,
		tokensIn: result.tokensIn,
		tokensOut: result.tokensOut,
	};
}

// ── Comparison logic ──

function normalizeLawName(name: string): string {
	return name
		.toLowerCase()
		.replace(/\s+/g, " ")
		.replace(/ley orgánica/g, "lo")
		.replace(/real decreto legislativo/g, "rdl")
		.replace(/real decreto/g, "rd")
		.replace(/texto refundido de la /g, "")
		.replace(/texto refundido del /g, "")
		.replace(/general de /g, "")
		.replace(/,? de \d+ de \w+/g, "")
		.replace(/\d{1,2}\/\d{4}/g, "")
		.replace(/[.,;:()"'«»]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function findBestMatch(
	llmLaw: string,
	parserLaws: string[],
): string | undefined {
	const normalizedLlm = normalizeLawName(llmLaw);

	// Try exact normalized match first
	for (const pl of parserLaws) {
		if (normalizeLawName(pl) === normalizedLlm) return pl;
	}

	// Try substring match
	const llmWords = normalizedLlm
		.split(" ")
		.filter((w) => w.length > 3);
	for (const pl of parserLaws) {
		const normalizedPl = normalizeLawName(pl);
		const matchedWords = llmWords.filter((w) => normalizedPl.includes(w));
		if (matchedWords.length >= Math.max(1, llmWords.length * 0.5)) {
			return pl;
		}
	}

	// Try reverse: parser law words in LLM name
	for (const pl of parserLaws) {
		const plWords = normalizeLawName(pl)
			.split(" ")
			.filter((w) => w.length > 3);
		const matchedWords = plWords.filter((w) => normalizedLlm.includes(w));
		if (matchedWords.length >= Math.max(1, plWords.length * 0.5)) {
			return pl;
		}
	}

	return undefined;
}

// ── Main ──

interface BillReport {
	id: string;
	name: string;
	parserGroups: number;
	llmGroups: number;
	matchedBoth: string[];
	parserOnly: string[];
	llmOnly: string[];
	cost: number;
	tokensIn: number;
	tokensOut: number;
}

async function main() {
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║  Spike: LLM Verification of Bill Parser         ║");
	console.log("║  Model: gemini-2.5-flash-lite via OpenRouter     ║");
	console.log("╚══════════════════════════════════════════════════╝\n");

	const reports: BillReport[] = [];
	let totalCost = 0;

	for (const bill of BILLS) {
		console.log(`\n${"=".repeat(60)}`);
		console.log(`=== ${bill.id} ===`);
		console.log(`    ${bill.name}`);
		console.log(`${"=".repeat(60)}`);

		// 1. Extract text
		console.log("  [1/3] Extracting text from PDF...");
		const text = extractTextFromPdf(bill.pdf);
		console.log(`        ${text.length} chars extracted`);

		// 2. Run regex parser
		console.log("  [2/3] Running regex parser (with LLM fallback)...");
		const parsed = await parseBill(text, { apiKey });
		const parserLaws = parsed.modificationGroups.map((g) => g.targetLaw);
		console.log(
			`        Parser found: ${parsed.modificationGroups.length} groups`,
		);
		for (const g of parsed.modificationGroups) {
			console.log(
				`          - [${g.modifications.length} mods] ${g.title.slice(0, 80)}`,
			);
		}

		// 3. Run LLM extraction
		console.log("  [3/3] Running LLM extraction...");
		const llm = await llmExtractGroups(text);
		console.log(`        LLM found: ${llm.groups.length} groups`);
		for (const g of llm.groups) {
			console.log(
				`          - [~${g.estimated_modifications} mods] ${g.section_type}: ${g.target_law.slice(0, 70)}`,
			);
		}

		// 4. Compare
		const matchedBoth: string[] = [];
		const llmOnly: string[] = [];
		const matchedParserLaws = new Set<string>();

		for (const llmGroup of llm.groups) {
			const match = findBestMatch(llmGroup.target_law, parserLaws);
			if (match) {
				matchedBoth.push(
					`${llmGroup.target_law} <-> ${match}`,
				);
				matchedParserLaws.add(match);
			} else {
				llmOnly.push(
					`${llmGroup.section_type}: ${llmGroup.target_law} (~${llmGroup.estimated_modifications} mods)`,
				);
			}
		}

		const parserOnly = parserLaws.filter((l) => !matchedParserLaws.has(l));

		// 5. Report
		console.log("\n  --- COMPARISON ---");
		console.log(`  Parser found: ${parserLaws.length} groups`);
		console.log(`  LLM found:    ${llm.groups.length} groups`);
		console.log(`  MATCHED:      ${matchedBoth.length} laws found by both`);

		if (parserOnly.length > 0) {
			console.log(`  PARSER ONLY:  ${parserOnly.length} laws`);
			for (const l of parserOnly) {
				console.log(`    - ${l}`);
			}
		}

		if (llmOnly.length > 0) {
			console.log(`  LLM ONLY:     ${llmOnly.length} laws (parser missed these!)`);
			for (const l of llmOnly) {
				console.log(`    - ${l}`);
			}
		}

		// Verdict
		let verdict: string;
		if (llmOnly.length === 0 && parserOnly.length === 0) {
			verdict = "PERFECT MATCH";
		} else if (llmOnly.length === 0) {
			verdict = "Parser is a superset of LLM";
		} else if (parserOnly.length === 0) {
			verdict = "LLM is a superset of Parser -- PARSER HAS GAPS";
		} else {
			verdict = "BOTH HAVE UNIQUE FINDS";
		}
		console.log(`  VERDICT: ${verdict}`);
		console.log(
			`  Cost: $${llm.cost.toFixed(6)} (${llm.tokensIn} in / ${llm.tokensOut} out)`,
		);

		totalCost += llm.cost;

		reports.push({
			id: bill.id,
			name: bill.name,
			parserGroups: parserLaws.length,
			llmGroups: llm.groups.length,
			matchedBoth,
			parserOnly,
			llmOnly,
			cost: llm.cost,
			tokensIn: llm.tokensIn,
			tokensOut: llm.tokensOut,
		});
	}

	// ── Final Summary ──
	console.log("\n\n");
	console.log("╔══════════════════════════════════════════════════╗");
	console.log("║                  FINAL SUMMARY                   ║");
	console.log("╚══════════════════════════════════════════════════╝\n");

	let totalLlmOnlyCount = 0;
	let totalParserOnlyCount = 0;

	for (const r of reports) {
		const status =
			r.llmOnly.length === 0 && r.parserOnly.length === 0
				? "PERFECT"
				: r.llmOnly.length > 0
					? "GAPS"
					: "OK";
		const icon = status === "PERFECT" ? "[=]" : status === "GAPS" ? "[!]" : "[+]";
		console.log(
			`  ${icon} ${r.id}: Parser ${r.parserGroups} / LLM ${r.llmGroups} / Matched ${r.matchedBoth.length} / Parser-only ${r.parserOnly.length} / LLM-only ${r.llmOnly.length}`,
		);
		totalLlmOnlyCount += r.llmOnly.length;
		totalParserOnlyCount += r.parserOnly.length;
	}

	console.log(`\n  Total discrepancies:`);
	console.log(
		`    - LLM found but parser missed: ${totalLlmOnlyCount} (these are the VALUABLE ones)`,
	);
	console.log(
		`    - Parser found but LLM missed: ${totalParserOnlyCount} (parser extras)`,
	);
	console.log(`\n  Total LLM cost: $${totalCost.toFixed(6)}`);

	if (totalLlmOnlyCount > 0) {
		console.log(
			"\n  >> LLM found gaps in the parser! Details of missed laws:",
		);
		for (const r of reports) {
			if (r.llmOnly.length > 0) {
				console.log(`\n  ${r.id} (${r.name}):`);
				for (const l of r.llmOnly) {
					console.log(`    - ${l}`);
				}
			}
		}
	}

	console.log("\n  Done.");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
