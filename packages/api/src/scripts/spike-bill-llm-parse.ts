/**
 * Spike: Compare parsing approaches for bill modifications
 *
 * Tests 3 approaches on the same bill (solo sí es sí):
 * A) Current regex parser (baseline)
 * B) LLM-only: send each DF text to Gemini Flash Lite for structured extraction
 * C) Hybrid: mechanical split by DFs + LLM for classification of each
 *
 * The key insight: the SPLIT into groups (finding DFs) is the bottleneck, not
 * the classification of individual modifications. So we test splitting approaches.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... bun run packages/api/src/scripts/spike-bill-llm-parse.ts
 */

import { execFileSync } from "node:child_process";
import { callOpenRouter } from "../services/openrouter.ts";

const BILL_PDF = "./data/spike-bills/BOCG-14-A-62-1.PDF";
const MODEL = "google/gemini-2.5-flash-lite";
const apiKey = process.env.OPENROUTER_API_KEY ?? "";

if (!apiKey) {
	console.error("Set OPENROUTER_API_KEY");
	process.exit(1);
}

// ── Ground truth: 14 DFs in the proyecto de ley ──

const GROUND_TRUTH_DFS = [
	{ ordinal: "primera", law: "Ley de Enjuiciamiento Criminal", modsExpected: 4 },
	{ ordinal: "segunda", law: "LO 8/1985, Derecho a la Educación", modsExpected: 1 },
	{ ordinal: "tercera", law: "Ley 34/1988, General de Publicidad", modsExpected: 1 },
	{ ordinal: "cuarta", law: "LO 10/1995, Código Penal", modsExpected: 24 },
	{ ordinal: "quinta", law: "Ley 35/1995, Víctimas", modsExpected: 7 },
	{ ordinal: "sexta", law: "LO 4/2000, Extranjería", modsExpected: 1 },
	{ ordinal: "séptima", law: "Ley 38/2003, Subvenciones", modsExpected: 1 },
	{ ordinal: "octava", law: "LO 3/2007, Igualdad", modsExpected: 5 },
	{ ordinal: "novena", law: "Ley 20/2007, Trabajo Autónomo", modsExpected: 21 },
	{ ordinal: "décima", law: "Ley 4/2015, Víctima del Delito", modsExpected: 8 },
	{ ordinal: "undécima", law: "LO 14/2015, Código Penal Militar", modsExpected: 4 },
	{ ordinal: "duodécima", law: "Estatuto de los Trabajadores", modsExpected: 6 },
	{ ordinal: "decimotercera", law: "EBEP", modsExpected: 3 },
	{ ordinal: "decimocuarta", law: "LGSS", modsExpected: 14 },
];

// ── Extract text ──

function extractText(pdfPath: string): string {
	return execFileSync("pdftotext", ["-raw", pdfPath, "-"], {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
	})
		.replace(/cve: BOCG-\d+-[A-Z]-\d+-\d+/g, "")
		.replace(/BOLETÍN OFICIAL DE LAS CORTES GENERALES\nCONGRESO DE LOS DIPUTADOS\n/g, "")
		.replace(/Serie [AB] Núm\. \d+-\d+\s+\d+ de \w+ de \d+\s+Pág\. \d+/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ── Approach A: Current regex parser ──

async function approachA(text: string) {
	const { parseBill } = await import("../services/bill-parser/parser.ts");
	const bill = await parseBill(text);
	return {
		groups: bill.modificationGroups.length,
		totalMods: bill.modificationGroups.reduce((s, g) => s + g.modifications.length, 0),
		details: bill.modificationGroups.map((g) => ({
			law: g.targetLaw.slice(0, 60),
			mods: g.modifications.length,
		})),
	};
}

// ── Approach B: Mechanical DF split + single LLM call per bill section ──
// Split the text mechanically by "Disposición final X." boundaries,
// then send each section to LLM for structured extraction

async function approachB(text: string) {
	// Step 1: Find the disposiciones finales section (after "Disposición derogatoria")
	const derogatoriaIdx = text.lastIndexOf("Disposición derogatoria");
	const dfsSection = derogatoriaIdx > 0
		? text.slice(derogatoriaIdx)
		: text.slice(text.length / 2); // fallback: second half

	// Step 2: Mechanically split by "Disposición final X."
	const dfBoundaries = [...dfsSection.matchAll(
		/\nDisposición final (\w+)\./g,
	)];

	const dfSections: Array<{ ordinal: string; text: string }> = [];
	for (let i = 0; i < dfBoundaries.length; i++) {
		const start = dfBoundaries[i]!.index!;
		const end = i + 1 < dfBoundaries.length ? dfBoundaries[i + 1]!.index! : dfsSection.length;
		const sectionText = dfsSection.slice(start, end).trim();
		// Only include if it has "Modificación" in the title
		const firstLine = sectionText.split("\n")[0] ?? "";
		if (/Modificación/i.test(firstLine)) {
			dfSections.push({
				ordinal: dfBoundaries[i]![1]!,
				text: sectionText,
			});
		}
	}

	console.log(`  Mechanical split found ${dfSections.length} DFs with "Modificación"`);

	// Step 3: For each DF section, use LLM to extract modifications
	let totalMods = 0;
	let totalCost = 0;
	const details: Array<{ law: string; mods: number; method: string }> = [];

	for (const df of dfSections) {
		// Truncate to ~4000 chars to save tokens (first part has the structure)
		const truncated = df.text.slice(0, 4000);

		const result = await callOpenRouter<{
			target_law: string;
			modifications: Array<{
				change_type: string;
				target_provision: string;
			}>;
		}>(apiKey, {
			model: MODEL,
			messages: [
				{
					role: "system",
					content: `Eres un parser de textos legislativos españoles. Dado el texto de una Disposición Final que modifica una ley existente, extrae:
1. "target_law": nombre de la ley que se modifica (breve)
2. "modifications": array de cada modificación individual con:
   - "change_type": uno de "modify", "add", "delete", "renumber", "suppress_chapter"
   - "target_provision": qué se modifica (ej: "artículo 178", "apartado 2 del artículo 83")
Responde SOLO con JSON.`,
				},
				{ role: "user", content: truncated },
			],
			temperature: 0,
			maxTokens: 1000,
		});

		totalCost += result.cost;
		const mods = result.data.modifications?.length ?? 0;
		totalMods += mods;
		details.push({
			law: result.data.target_law?.slice(0, 60) ?? df.ordinal,
			mods,
			method: "llm",
		});
	}

	return { groups: dfSections.length, totalMods, details, cost: totalCost };
}

// ── Approach C: Fully mechanical improved split (fix the actual bug) ──
// The bug is that extractDFGroups skips DFs without ordinals.
// Fix: treat single-modification DFs as groups too.

async function approachC(text: string) {
	// Find the body section (second occurrence of each DF, not the index)
	const allDfPositions = [...text.matchAll(
		/Disposición final (\w+)\. (Modificación [^\n]+)/g,
	)];

	// Deduplicate: keep only DFs that have actual content (not index entries)
	// Index entries are short (~100 chars until next DF), body entries are longer
	const dfSections: Array<{ ordinal: string; title: string; text: string }> = [];

	for (let i = 0; i < allDfPositions.length; i++) {
		const pos = allDfPositions[i]!;
		// Find next DF or Disposición boundary
		const nextBoundary = text.indexOf("\nDisposición ", pos.index! + 50);
		const sectionEnd = nextBoundary > 0 ? nextBoundary : text.length;
		const sectionText = text.slice(pos.index!, sectionEnd);

		// Skip index entries (very short, <500 chars)
		if (sectionText.length < 500) continue;

		// Parse modifications: look for ordinals OR single "Se modifica/añade/suprime"
		const hasOrdinals = /\n(?:Uno|Dos|Tres|Cuatro|Cinco)\. /.test(sectionText);
		let mods = 0;

		if (hasOrdinals) {
			// Count ordinals
			const ordinalMatches = sectionText.match(
				/\n(?:Uno|Dos|Tres|Cuatro|Cinco|Seis|Siete|Ocho|Nueve|Diez|Once|Doce|Trece|Catorce|Quince|Dieciséis|Diecisiete|Dieciocho|Diecinueve|Veinte|Veintiuno)\. /g,
			);
			mods = ordinalMatches?.length ?? 0;
		} else {
			// Single modification (no ordinals) — count "Se modifica/añade/suprime" patterns
			const singleMods = sectionText.match(
				/\nSe (?:modifica|añade|suprime|introduce|deroga)/gi,
			);
			mods = singleMods?.length ?? 0;
			if (mods === 0) mods = 1; // At minimum 1 mod if it's a Modificación DF
		}

		const lawMatch = pos[2]!.match(
			/Modificación (?:de|del) (?:la |el |los |las )?(.+)/,
		);

		dfSections.push({
			ordinal: pos[1]!,
			title: lawMatch ? lawMatch[1]!.slice(0, 60) : pos[2]!.slice(0, 60),
			text: sectionText,
		});
	}

	const totalMods = dfSections.reduce((s, df) => {
		const hasOrdinals = /\n(?:Uno|Dos|Tres)\. /.test(df.text);
		if (hasOrdinals) {
			const ordinalMatches = df.text.match(
				/\n(?:Uno|Dos|Tres|Cuatro|Cinco|Seis|Siete|Ocho|Nueve|Diez|Once|Doce|Trece|Catorce|Quince|Dieciséis|Diecisiete|Dieciocho|Diecinueve|Veinte|Veintiuno|Veintidós|Veintitrés|Veinticuatro)\. /g,
			);
			return s + (ordinalMatches?.length ?? 0);
		}
		const singles = df.text.match(/\nSe (?:modifica|añade|suprime|introduce|deroga)/gi);
		return s + (singles?.length ?? 1);
	}, 0);

	return {
		groups: dfSections.length,
		totalMods,
		details: dfSections.map((df) => ({
			law: df.title,
			mods: 0, // simplified
		})),
	};
}

// ── Main ──

console.log("═══════════════════════════════════════════════════════");
console.log("  SPIKE: Parsing Approach Comparison");
console.log("  Bill: BOCG-14-A-62-1 (solo sí es sí)");
console.log("  Ground truth: 14 DFs, ~100 modifications");
console.log("═══════════════════════════════════════════════════════\n");

const text = extractText(BILL_PDF);
console.log(`  Text: ${text.length.toLocaleString()} chars\n`);

// Ground truth
const gtGroups = GROUND_TRUTH_DFS.length;
const gtMods = GROUND_TRUTH_DFS.reduce((s, df) => s + df.modsExpected, 0);
console.log(`  Ground truth: ${gtGroups} groups, ${gtMods} mods\n`);

// Approach A: Regex
console.log("── Approach A: Current regex parser ──");
const resultA = await approachA(text);
console.log(`  Groups: ${resultA.groups}/${gtGroups} (${((resultA.groups / gtGroups) * 100).toFixed(0)}%)`);
console.log(`  Mods:   ${resultA.totalMods}/${gtMods} (${((resultA.totalMods / gtMods) * 100).toFixed(0)}%)`);
console.log(`  Cost:   $0`);
for (const d of resultA.details) {
	console.log(`    ${d.law}: ${d.mods} mods`);
}
console.log();

// Approach B: Mechanical split + LLM
console.log("── Approach B: Mechanical DF split + LLM classification ──");
const startB = Date.now();
const resultB = await approachB(text);
const timeB = Date.now() - startB;
console.log(`  Groups: ${resultB.groups}/${gtGroups} (${((resultB.groups / gtGroups) * 100).toFixed(0)}%)`);
console.log(`  Mods:   ${resultB.totalMods}/${gtMods} (${((resultB.totalMods / gtMods) * 100).toFixed(0)}%)`);
console.log(`  Cost:   $${resultB.cost.toFixed(4)}`);
console.log(`  Time:   ${(timeB / 1000).toFixed(1)}s`);
for (const d of resultB.details) {
	console.log(`    ${d.law}: ${d.mods} mods [${d.method}]`);
}
console.log();

// Approach C: Improved mechanical split
console.log("── Approach C: Improved mechanical split (fix single-mod DFs) ──");
const resultC = await approachC(text);
console.log(`  Groups: ${resultC.groups}/${gtGroups} (${((resultC.groups / gtGroups) * 100).toFixed(0)}%)`);
console.log(`  Mods:   ${resultC.totalMods}/${gtMods} (${((resultC.totalMods / gtMods) * 100).toFixed(0)}%)`);
console.log(`  Cost:   $0`);
console.log();

// Comparison table
console.log("── Comparison ──\n");
console.log("| Approach | Groups | Mods | Cost | Time |");
console.log("|----------|--------|------|------|------|");
console.log(`| Ground truth | ${gtGroups} | ${gtMods} | — | — |`);
console.log(`| A) Regex (current) | ${resultA.groups} (${((resultA.groups / gtGroups) * 100).toFixed(0)}%) | ${resultA.totalMods} (${((resultA.totalMods / gtMods) * 100).toFixed(0)}%) | $0 | <1s |`);
console.log(`| B) Split + LLM | ${resultB.groups} (${((resultB.groups / gtGroups) * 100).toFixed(0)}%) | ${resultB.totalMods} (${((resultB.totalMods / gtMods) * 100).toFixed(0)}%) | $${resultB.cost.toFixed(4)} | ${(timeB / 1000).toFixed(1)}s |`);
console.log(`| C) Improved split | ${resultC.groups} (${((resultC.groups / gtGroups) * 100).toFixed(0)}%) | ${resultC.totalMods} (${((resultC.totalMods / gtMods) * 100).toFixed(0)}%) | $0 | <1s |`);
console.log();
