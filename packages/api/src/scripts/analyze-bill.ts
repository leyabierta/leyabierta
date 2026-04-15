/**
 * Bill Analyzer — full pipeline from BOCG PDF to structured DB data.
 *
 * 1. Downloads PDF (if URL) or reads local file
 * 2. Extracts text via pdftotext
 * 3. Runs parser (8 strategies, optional LLM)
 * 4. Runs analyzer (penalties, DTs, blast radius against legislation DB)
 * 5. Runs LLM impact analysis per modification group
 * 6. Saves everything to SQLite (bills, bill_modifications, bill_impacts)
 *
 * Usage:
 *   bun run packages/api/src/scripts/analyze-bill.ts --url https://www.congreso.es/...PDF
 *   bun run packages/api/src/scripts/analyze-bill.ts --file ./data/spike-bills/BOCG-14-A-62-1.PDF
 *   bun run packages/api/src/scripts/analyze-bill.ts --url ... --skip-llm-impact
 *   bun run packages/api/src/scripts/analyze-bill.ts --url ... --force   # re-analyze even if exists
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AffectedNorm,
	analyzeBill,
	formatReport,
	type ImpactReport,
	resolveNormId,
} from "../services/bill-parser/analyzer.ts";
import {
	extractTextFromPdf,
	type ModificationGroup,
	type ParsedBill,
	parseBill,
} from "../services/bill-parser/parser.ts";
import { callOpenRouter } from "../services/openrouter.ts";
import { getArg, hasFlag, setupDb } from "./shared.ts";

// ── Config ──

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const IMPACT_MODEL = "google/gemini-2.5-flash-lite";
const DOWNLOAD_DIR = "./data/spike-bills";

// ── CLI ──

const url = getArg("url");
const filePath = getArg("file");
const skipLlmImpact = hasFlag("skip-llm-impact");
const force = hasFlag("force");

if (!url && !filePath) {
	console.error(
		"Usage: bun run analyze-bill.ts --url <PDF_URL> | --file <PATH>",
	);
	console.error("Options:");
	console.error(
		"  --skip-llm-impact  Skip LLM impact analysis (faster, cheaper)",
	);
	console.error("  --force            Re-analyze even if bill already in DB");
	process.exit(1);
}

// ── Helpers ──

async function downloadPdf(pdfUrl: string): Promise<string> {
	mkdirSync(DOWNLOAD_DIR, { recursive: true });

	// Extract filename from URL: BOCG-14-A-62-1.PDF
	const urlParts = pdfUrl.split("/");
	const filename = urlParts[urlParts.length - 1] ?? "bill.pdf";
	const localPath = join(DOWNLOAD_DIR, filename);

	if (existsSync(localPath)) {
		console.log(`  PDF already downloaded: ${localPath}`);
		return localPath;
	}

	console.log(`  Downloading PDF from ${pdfUrl}...`);
	const response = await fetch(pdfUrl, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (compatible; LeyAbierta/1.0; +https://leyabierta.es)",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to download PDF: ${response.status} ${response.statusText}`,
		);
	}

	const buffer = await response.arrayBuffer();
	writeFileSync(localPath, Buffer.from(buffer));
	console.log(
		`  Downloaded ${(buffer.byteLength / 1024).toFixed(0)} KB -> ${localPath}`,
	);
	return localPath;
}

// ── LLM Impact Analysis ──

interface ImpactVariable {
	variable: string;
	current_state: string;
	proposed_state: string;
	impact_risk: "low" | "medium" | "high" | "critical";
	retroactivity: boolean;
	explanation: string;
}

interface GroupImpactAnalysis {
	target_law: string;
	norm_id: string;
	summary: string;
	variables: ImpactVariable[];
}

async function analyzeGroupImpact(
	db: ReturnType<typeof setupDb>["db"],
	group: ModificationGroup,
	bill: ParsedBill,
): Promise<GroupImpactAnalysis | null> {
	if (!OPENROUTER_API_KEY) return null;
	if (group.modifications.length === 0) return null;

	// Build context: current law text + proposed changes
	const normId = group.normId ?? "";
	let currentTexts = "";

	if (normId) {
		// Fetch current text of modified articles from DB
		for (const mod of group.modifications.slice(0, 20)) {
			const artMatch = mod.targetProvision.match(
				/art[ií]culo\s+(\d+(?:\s*(?:bis|ter|qu[aá]ter|quinquies))?)/i,
			);
			if (!artMatch?.[1]) continue;
			const artNum = artMatch[1].trim().replace(/\s+/g, "");
			const blockId = `a${artNum}`;
			const block = db
				.query<{ current_text: string }, [string, string]>(
					"SELECT current_text FROM blocks WHERE norm_id = ? AND block_id = ?",
				)
				.get(normId, blockId);
			if (block?.current_text) {
				currentTexts += `\n--- Artículo ${artNum} (texto vigente) ---\n${block.current_text.slice(0, 2000)}\n`;
			}
		}
	}

	// Build proposed text summary
	const proposedSummary = group.modifications
		.slice(0, 20)
		.map(
			(m) =>
				`[${m.changeType}] ${m.targetProvision}: ${m.newText?.slice(0, 500) || m.sourceText.slice(0, 500)}`,
		)
		.join("\n\n");

	const prompt = `Analiza el impacto de estas modificaciones legislativas propuestas sobre la legislación vigente.

LEY MODIFICADA: ${group.targetLaw}

${currentTexts ? `TEXTO VIGENTE DE LOS ARTÍCULOS AFECTADOS:\n${currentTexts}` : ""}

MODIFICACIONES PROPUESTAS:
${proposedSummary}

CONTEXTO: Este es un proyecto de ley (${bill.bocgId}) publicado el ${bill.publicationDate}.

Genera un análisis estructurado. Para cada cambio significativo, identifica:
- variable: qué aspecto legal cambia (e.g., "Pena mínima art. 178", "Tipo penal de sedición")
- current_state: estado actual según la ley vigente
- proposed_state: estado propuesto por el proyecto
- impact_risk: low/medium/high/critical
- retroactivity: true si el cambio podría tener efectos retroactivos (especialmente en materia penal)
- explanation: explicación breve del impacto

IMPORTANTE:
- Solo reporta cambios que estén explícitamente en el texto, no inventes riesgos
- Si el texto propuesto es idéntico o equivalente al vigente, NO lo incluyas como variable — solo reporta cambios reales donde haya una diferencia material
- Sé conservador con el nivel de riesgo: critical solo para bajadas de penas o eliminación de tipos penales
- Si no hay cambios significativos, devuelve un array vacío de variables

Responde en JSON con este schema:
{
  "summary": "resumen de 1-2 frases del impacto general",
  "variables": [{ "variable", "current_state", "proposed_state", "impact_risk", "retroactivity", "explanation" }]
}`;

	try {
		const result = await callOpenRouter<GroupImpactAnalysis>(
			OPENROUTER_API_KEY,
			{
				model: IMPACT_MODEL,
				messages: [
					{
						role: "system",
						content:
							"Eres un analista legislativo experto en derecho español. Analizas proyectos de ley comparando el texto propuesto con la legislación vigente. Eres preciso y conservador: solo reportas riesgos que estén respaldados por el texto.",
					},
					{ role: "user", content: prompt },
				],
				temperature: 0.1,
				maxTokens: 4000,
				jsonSchema: {
					name: "impact_analysis",
					schema: {
						type: "object",
						properties: {
							summary: { type: "string" },
							variables: {
								type: "array",
								items: {
									type: "object",
									properties: {
										variable: { type: "string" },
										current_state: { type: "string" },
										proposed_state: { type: "string" },
										impact_risk: {
											type: "string",
											enum: ["low", "medium", "high", "critical"],
										},
										retroactivity: { type: "boolean" },
										explanation: { type: "string" },
									},
									required: [
										"variable",
										"current_state",
										"proposed_state",
										"impact_risk",
										"retroactivity",
										"explanation",
									],
									additionalProperties: false,
								},
							},
						},
						required: ["summary", "variables"],
						additionalProperties: false,
					},
				},
			},
		);

		// Post-filter: remove variables where current_state ≈ proposed_state (LLM false positives)
		const rawVariables = result.data.variables ?? [];
		const originalCount = rawVariables.length;

		const filteredVariables = rawVariables.filter((v) => {
			if (!v.current_state || !v.proposed_state) return true;
			// Normalize whitespace and punctuation for comparison
			const normalize = (s: string) =>
				s
					.toLowerCase()
					.replace(/\s+/g, " ")
					.replace(/[.,;:]+$/, "")
					.trim();
			const current = normalize(v.current_state);
			const proposed = normalize(v.proposed_state);
			if (current === proposed) {
				console.log(
					`  [post-filter] Removed identical variable: "${v.variable}"`,
				);
				return false;
			}
			// Also filter if one is a substring of the other (>90% overlap)
			if (current.length > 20 && proposed.length > 20) {
				const shorter = current.length < proposed.length ? current : proposed;
				const longer = current.length < proposed.length ? proposed : current;
				if (longer.includes(shorter) && shorter.length / longer.length > 0.9) {
					console.log(
						`  [post-filter] Removed near-identical variable: "${v.variable}"`,
					);
					return false;
				}
			}
			return true;
		});

		if (originalCount !== filteredVariables.length) {
			console.log(
				`  [post-filter] Removed ${originalCount - filteredVariables.length} false positive(s)`,
			);
		}

		return {
			target_law: group.targetLaw,
			norm_id: normId,
			summary: result.data.summary ?? "",
			variables: filteredVariables,
		};
	} catch (err) {
		console.error(
			`  WARNING: LLM impact analysis failed for "${group.targetLaw}": ${err}`,
		);
		return null;
	}
}

// ── DB persistence ──

function saveBillToDb(
	db: ReturnType<typeof setupDb>["db"],
	bill: ParsedBill,
	report: ImpactReport,
	impacts: GroupImpactAnalysis[],
	affectedNormsMap: Map<string, AffectedNorm[]>,
	model: string,
): void {
	// Extract legislature and series from bocgId: BOCG-14-A-62-1 -> legislature=14, series=A
	const bocgParts = bill.bocgId.match(/BOCG-(\d+)-([AB])/);
	const legislature = bocgParts?.[1] ? Number.parseInt(bocgParts[1], 10) : 0;
	const series = bocgParts?.[2] ?? "";

	const alertLevel =
		report.summary.criticalAlerts > 0
			? "critical"
			: report.summary.highAlerts > 0
				? "high"
				: "ok";

	db.exec("BEGIN TRANSACTION");

	try {
		// 1. Insert bill
		db.run(
			`INSERT OR REPLACE INTO bills (
				bocg_id, title, legislature, series, publication_date, pdf_url,
				bill_type, alert_level, total_modifications, laws_modified,
				critical_alerts, high_alerts, has_penalty_changes, has_type_eliminations,
				transitional_check_json, analyzed_at, model, warnings_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				bill.bocgId,
				bill.title,
				legislature,
				series,
				bill.publicationDate,
				url ?? "",
				bill.billType,
				alertLevel,
				report.summary.totalModifications,
				report.summary.lawsModified,
				report.summary.criticalAlerts,
				report.summary.highAlerts,
				report.penaltyAnalysis.some((p) => p.risk !== "none") ? 1 : 0,
				report.typeEliminations.length > 0 ? 1 : 0,
				JSON.stringify(report.transitionalCheck),
				new Date().toISOString(),
				model,
				JSON.stringify(bill.warnings ?? []),
			],
		);

		// 2. Delete existing modifications (for --force re-analysis)
		db.run("DELETE FROM bill_modifications WHERE bocg_id = ?", [bill.bocgId]);

		// 3. Insert modifications
		const insertMod = db.prepare(
			`INSERT INTO bill_modifications (
				bocg_id, group_index, group_title, target_law, norm_id,
				ordinal, change_type, target_provision, new_text, source_text,
				penalty_risk, penalty_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		for (let gi = 0; gi < report.groups.length; gi++) {
			const group = report.groups[gi]!;
			for (const mod of group.modifications) {
				// Find matching penalty comparison
				const penaltyMatch = report.penaltyAnalysis.find((p) => {
					const artNum = mod.targetProvision.match(
						/art[ií]culo\s+(\d+(?:\s*(?:bis|ter|qu[aá]ter))?)/i,
					);
					return artNum?.[1] && p.article.includes(artNum[1]);
				});

				insertMod.run(
					bill.bocgId,
					gi,
					group.title,
					group.targetLaw,
					group.normId ?? "",
					mod.ordinal,
					mod.changeType,
					mod.targetProvision,
					mod.newText ?? "",
					mod.sourceText,
					penaltyMatch?.risk ?? "none",
					penaltyMatch ? JSON.stringify(penaltyMatch) : "{}",
				);
			}
		}

		// 4. Delete existing impacts (for --force)
		db.run("DELETE FROM bill_impacts WHERE bocg_id = ?", [bill.bocgId]);

		// 5. Insert impacts
		const insertImpact = db.prepare(
			`INSERT INTO bill_impacts (
				bocg_id, norm_id, target_law, impact_json, blast_radius_json,
				generated_at, model
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const impact of impacts) {
			const blastRadius = affectedNormsMap.get(impact.norm_id) ?? [];
			insertImpact.run(
				bill.bocgId,
				impact.norm_id,
				impact.target_law,
				JSON.stringify(impact),
				JSON.stringify(blastRadius),
				new Date().toISOString(),
				model,
			);
		}

		// 6. Delete existing derogations (for --force)
		db.run("DELETE FROM bill_derogations WHERE bocg_id = ?", [bill.bocgId]);

		// 7. Insert derogations
		const insertDerog = db.prepare(
			`INSERT INTO bill_derogations (
				bocg_id, target_law, norm_id, scope, target_provisions, source_text
			) VALUES (?, ?, ?, ?, ?, ?)`,
		);

		for (const derog of bill.derogations) {
			const normId = resolveNormId(db, derog.targetLaw) ?? "";
			insertDerog.run(
				bill.bocgId,
				derog.targetLaw,
				normId,
				derog.scope,
				JSON.stringify(derog.targetProvisions),
				derog.text,
			);
		}

		// 8. Delete existing entities (for --force)
		db.run("DELETE FROM bill_entities WHERE bocg_id = ?", [bill.bocgId]);

		// 9. Insert new entities
		const insertEntity = db.prepare(
			`INSERT INTO bill_entities (
				bocg_id, name, entity_type, article, description
			) VALUES (?, ?, ?, ?, ?)`,
		);

		for (const entity of bill.newEntities) {
			insertEntity.run(
				bill.bocgId,
				entity.name,
				entity.entityType,
				entity.article,
				entity.description,
			);
		}

		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

// ── Main ──

async function main() {
	console.log(`\n${"=".repeat(60)}`);
	console.log("  BILL ANALYZER — Phase 2 Pipeline");
	console.log(`${"=".repeat(60)}\n`);

	const { db } = setupDb();

	// Step 1: Get PDF
	let pdfPath: string;
	if (url) {
		pdfPath = await downloadPdf(url);
	} else {
		pdfPath = filePath!;
		if (!existsSync(pdfPath)) {
			console.error(`  ERROR: File not found: ${pdfPath}`);
			process.exit(1);
		}
	}

	// Step 2: Extract text
	console.log("  [1/5] Extracting text from PDF...");
	const text = extractTextFromPdf(pdfPath);
	console.log(`         ${text.length.toLocaleString()} characters extracted`);

	// Step 3: Parse bill
	console.log("  [2/5] Parsing bill structure...");
	const parsed = await parseBill(text, {
		apiKey: OPENROUTER_API_KEY || undefined,
	});
	console.log(`         BOCG ID: ${parsed.bocgId}`);
	console.log(`         Title: ${parsed.title.slice(0, 80)}`);
	console.log(`         Date: ${parsed.publicationDate}`);
	console.log(`         Groups: ${parsed.modificationGroups.length}`);
	const totalMods = parsed.modificationGroups.reduce(
		(sum, g) => sum + g.modifications.length,
		0,
	);
	console.log(`         Total modifications: ${totalMods}`);
	console.log(`         Derogations: ${parsed.derogations.length}`);

	// Check if already analyzed
	if (!force) {
		const existing = db
			.query<{ bocg_id: string }, string>(
				"SELECT bocg_id FROM bills WHERE bocg_id = ?",
			)
			.get(parsed.bocgId);
		if (existing) {
			console.log(
				`\n  Bill ${parsed.bocgId} already analyzed. Use --force to re-analyze.`,
			);
			process.exit(0);
		}
	}

	// Step 4: Run impact analysis (deterministic)
	console.log(
		"  [3/5] Running impact analysis (penalties, DTs, blast radius)...",
	);
	const report = analyzeBill(db, parsed);

	console.log(`         Critical alerts: ${report.summary.criticalAlerts}`);
	console.log(`         High alerts: ${report.summary.highAlerts}`);
	console.log(`         Penalty comparisons: ${report.penaltyAnalysis.length}`);
	console.log(
		`         Affected norms (blast radius): ${report.affectedNorms.length}`,
	);

	// Print report to console
	console.log(`\n${formatReport(report)}`);

	// Build blast radius map: group affected norms by the modified law's normId.
	// affectedNorms come from findAffectedNorms(db, groupNormId, ...) — each affected
	// norm references a specific modified law. We match them to groups by checking which
	// group's normId was the target_id in the reference query.
	const affectedNormsMap = new Map<string, AffectedNorm[]>();
	const groupNormIds = new Set(
		report.groups.filter((g) => g.normId).map((g) => g.normId!),
	);
	for (const normId of groupNormIds) {
		// All affected norms were found by querying referencias WHERE target_id = normId,
		// so they all belong to this group's normId. Since currently only CP groups get
		// blast radius analysis and they share the same normId, this is equivalent.
		affectedNormsMap.set(normId, [...report.affectedNorms]);
	}

	// Step 5: LLM impact analysis per group
	const impacts: GroupImpactAnalysis[] = [];
	const _totalCost = 0;

	if (!skipLlmImpact && OPENROUTER_API_KEY) {
		console.log(
			`  [4/5] Running LLM impact analysis (${report.groups.length} groups)...`,
		);

		for (let i = 0; i < report.groups.length; i++) {
			const group = report.groups[i]!;
			process.stdout.write(
				`         [${i + 1}/${report.groups.length}] ${group.targetLaw.slice(0, 50)}...`,
			);

			const impact = await analyzeGroupImpact(db, group, parsed);
			if (impact) {
				impacts.push(impact);
				console.log(` ${impact.variables.length} variables`);
			} else {
				console.log(" skipped");
			}
		}

		console.log(`         Total impacts: ${impacts.length}`);
	} else {
		console.log(
			"  [4/5] Skipping LLM impact analysis (no API key or --skip-llm-impact)",
		);
	}

	// Step 6: Save to DB
	console.log("  [5/5] Saving to database...");
	saveBillToDb(
		db,
		parsed,
		report,
		impacts,
		affectedNormsMap,
		skipLlmImpact ? "deterministic-only" : IMPACT_MODEL,
	);

	// Summary
	const alertLevel =
		report.summary.criticalAlerts > 0
			? "CRITICAL"
			: report.summary.highAlerts > 0
				? "HIGH"
				: "OK";

	console.log(`\n${"=".repeat(60)}`);
	console.log("  DONE");
	console.log("=".repeat(60));
	console.log(`  Bill: ${parsed.bocgId}`);
	console.log(`  Alert level: ${alertLevel}`);
	console.log(
		`  Modifications: ${totalMods} across ${report.groups.length} laws`,
	);
	console.log(`  LLM impacts: ${impacts.length} groups analyzed`);
	console.log(`  Saved to DB: bills, bill_modifications, bill_impacts`);
	console.log("");

	db.close();
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
