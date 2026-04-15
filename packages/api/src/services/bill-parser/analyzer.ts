/**
 * Bill Analyzer — compares parsed bill modifications against the legislation DB.
 *
 * Detects:
 * - Penalty reductions (critical for retroactive application under art. 2.2 CP)
 * - Type eliminations (entire crime categories removed)
 * - Missing or inadequate transitional provisions
 * - Blast radius (affected norms via reference graph)
 */

import type { Database } from "bun:sqlite";
import type { BillModification, ModificationGroup, ParsedBill } from "./parser";

// ── Types ──

export interface PenaltyRange {
	min: number;
	max: number;
	unit: string;
}

export interface PenaltyComparison {
	article: string;
	current: PenaltyRange | null;
	proposed: PenaltyRange | null;
	delta: { minChange: number; maxChange: number } | null;
	risk: "none" | "low" | "medium" | "high" | "critical";
	riskReason: string;
}

export interface TypeEliminationAlert {
	chapter: string;
	articlesAffected: string[];
	existingConvictions: boolean;
	risk: "critical";
	riskReason: string;
}

export interface TransitionalCheck {
	hasPenaltyTransitional: boolean;
	hasRevisionTransitional: boolean;
	modifiesPenalCode: boolean;
	changesPenalties: boolean;
	eliminatesTypes: boolean;
	risk: "none" | "high" | "critical";
	message: string;
}

export interface AffectedNorm {
	normId: string;
	title: string;
	relation: string;
	articleRefs: string[];
}

export interface ImpactReport {
	billId: string;
	groups: ModificationGroup[];
	penaltyAnalysis: PenaltyComparison[];
	typeEliminations: TypeEliminationAlert[];
	transitionalCheck: TransitionalCheck;
	affectedNorms: AffectedNorm[];
	summary: {
		totalModifications: number;
		lawsModified: number;
		criticalAlerts: number;
		highAlerts: number;
	};
}

// ── Norm ID resolution ──

// Well-known pre-codification laws referenced by name (no N/YYYY pattern)
const KNOWN_LAW_ALIASES: Array<{ pattern: RegExp; normId: string }> = [
	{ pattern: /Ley de Enjuiciamiento Criminal/i, normId: "BOE-A-1882-6036" },
	{ pattern: /Código Civil/i, normId: "BOE-A-1889-4763" },
	{ pattern: /Código de Comercio/i, normId: "BOE-A-1885-6627" },
];

export function resolveNormId(db: Database, lawTitle: string): string | null {
	// Extract law number pattern like "10/1995" or "1/2015"
	const numMatch = lawTitle.match(/(\d+\/\d{4})/);

	// For laws without N/YYYY pattern, try well-known aliases
	if (!numMatch) {
		for (const alias of KNOWN_LAW_ALIASES) {
			if (alias.pattern.test(lawTitle)) {
				// Verify the norm exists in DB
				const exists = db
					.query<{ id: string }, string>(
						"SELECT id FROM norms WHERE id = ? LIMIT 1",
					)
					.get(alias.normId);
				if (exists) return alias.normId;
			}
		}
		return null;
	}
	const lawNum = numMatch[1];

	// Extract rank + number: "Ley Orgánica 10/1995" or "Ley 35/1995"
	const rankMatch = lawTitle.match(
		/(Ley Orgánica|Ley|Real Decreto[- ]?[Ll]egislativo|Real Decreto|Decreto)\s+\d+\/\d{4}/,
	);

	if (rankMatch) {
		const fullPattern = rankMatch[0]; // e.g., "Ley Orgánica 10/1995"

		// Prefer norms whose title STARTS with the exact rank+number
		// This distinguishes "Ley Orgánica 10/1995, del Código Penal" from
		// "Ley Orgánica 1/2015, por la que se modifica la Ley Orgánica 10/1995..."
		const exact = db
			.query<{ id: string }, string>(
				"SELECT id FROM norms WHERE title LIKE ? LIMIT 1",
			)
			.get(`${fullPattern}%`);
		if (exact) return exact.id;

		// Fallback: contains pattern
		const contains = db
			.query<{ id: string }, string>(
				"SELECT id FROM norms WHERE title LIKE ? ORDER BY length(title) ASC LIMIT 1",
			)
			.get(`%${fullPattern}%`);
		if (contains) return contains.id;
	}

	// Last resort: search by law number
	// Exclude modifying norms (they reference the number but aren't the original)
	// Prefer shorter titles (original norms tend to be shorter than "Ley X por la que se modifica...")
	const norm = db
		.query<{ id: string }, [string]>(
			`SELECT id FROM norms
			 WHERE title LIKE ?
			 AND title NOT LIKE '%por la que se modifica%'
			 AND title NOT LIKE '%por el que se modifica%'
			 ORDER BY length(title) ASC
			 LIMIT 1`,
		)
		.get(`%${lawNum}%`);

	return norm?.id ?? null;
}

// ── Penalty extraction ──

const WORD_TO_NUMBER: Record<string, number> = {
	uno: 1,
	un: 1,
	una: 1,
	dos: 2,
	tres: 3,
	cuatro: 4,
	cinco: 5,
	seis: 6,
	siete: 7,
	ocho: 8,
	nueve: 9,
	diez: 10,
	once: 11,
	doce: 12,
	trece: 13,
	catorce: 14,
	quince: 15,
	dieciséis: 16,
	dieciseis: 16,
	diecisiete: 17,
	dieciocho: 18,
	diecinueve: 19,
	veinte: 20,
	veinticinco: 25,
	treinta: 30,
};

function wordToNumber(word: string): number | null {
	const num = Number(word);
	if (!Number.isNaN(num)) return num;
	return WORD_TO_NUMBER[word.toLowerCase()] ?? null;
}

function extractPenalties(text: string): PenaltyRange[] {
	const penalties: PenaltyRange[] = [];

	// "prisión de X a Y años"
	for (const match of text.matchAll(/prisi[oó]n de (\w+) a (\w+) años/gi)) {
		const min = wordToNumber(match[1]!);
		const max = wordToNumber(match[2]!);
		if (min !== null && max !== null) {
			penalties.push({ min, max, unit: "años prisión" });
		}
	}

	// "prisión de X meses a Y años"
	for (const match of text.matchAll(
		/prisi[oó]n de (\w+) meses a (\w+) años/gi,
	)) {
		const minMonths = wordToNumber(match[1]!);
		const maxYears = wordToNumber(match[2]!);
		if (minMonths !== null && maxYears !== null) {
			penalties.push({
				min: minMonths / 12,
				max: maxYears,
				unit: "años prisión",
			});
		}
	}

	// "prisión de X a Y meses"
	for (const match of text.matchAll(/prisi[oó]n de (\w+) a (\w+) meses/gi)) {
		const min = wordToNumber(match[1]!);
		const max = wordToNumber(match[2]!);
		if (min !== null && max !== null) {
			penalties.push({ min: min / 12, max: max / 12, unit: "años prisión" });
		}
	}

	// "multa de X a Y meses" (fine measured in months)
	for (const match of text.matchAll(/multa de (\w+) a (\w+) meses/gi)) {
		const min = wordToNumber(match[1]!);
		const max = wordToNumber(match[2]!);
		if (min !== null && max !== null) {
			penalties.push({ min, max, unit: "meses multa" });
		}
	}

	// "inhabilitación ... de X a Y años"
	for (const match of text.matchAll(
		/inhabilitaci[oó]n[\w\s]*?de (\w+) a (\w+) a[ñn]os/gi,
	)) {
		const min = wordToNumber(match[1]!);
		const max = wordToNumber(match[2]!);
		if (min !== null && max !== null) {
			penalties.push({ min, max, unit: "años inhabilitación" });
		}
	}

	return penalties;
}

// ── Penalty comparison ──

function comparePenalties(
	db: Database,
	modifications: BillModification[],
	normId: string,
	beforeDate: string,
): PenaltyComparison[] {
	const comparisons: PenaltyComparison[] = [];

	for (const mod of modifications) {
		if (
			mod.changeType !== "modify" &&
			mod.changeType !== "renumber" &&
			mod.changeType !== "add"
		)
			continue;
		if (!mod.newText) continue;

		const artMatch = mod.targetProvision.match(
			/art[ií]culo (\d+(?:\s*(?:bis|ter|qu[aá]ter|quinquies))?)/i,
		);
		if (!artMatch) continue;

		const articleNum = artMatch[1]!.trim().replace(/\s+/, " ");
		const blockId = `a${articleNum.replace(/\s+/g, "")}`;

		const preVersion = db
			.query<{ text: string; date: string }, [string, string, string]>(
				`SELECT text, date FROM versions
				 WHERE norm_id = ? AND block_id = ?
				 AND date < ?
				 ORDER BY date DESC
				 LIMIT 1`,
			)
			.get(normId, blockId, beforeDate);

		if (!preVersion?.text) continue;

		const currentPenalties = extractPenalties(preVersion.text);
		const proposedPenalties = extractPenalties(mod.newText);

		// Compare all extracted penalty pairs
		if (currentPenalties.length === 0 && proposedPenalties.length === 0)
			continue;

		// Compare each pair of penalties
		const maxPairs = Math.max(
			currentPenalties.length,
			proposedPenalties.length,
		);
		let worstRisk: PenaltyComparison["risk"] = "none";
		let worstRiskReason = "";
		let worstDelta: PenaltyComparison["delta"] = null;
		let bestCurrent: PenaltyRange | null = currentPenalties[0] ?? null;
		let bestProposed: PenaltyRange | null = proposedPenalties[0] ?? null;

		for (let pi = 0; pi < maxPairs; pi++) {
			const cur = currentPenalties[pi] ?? null;
			const prop = proposedPenalties[pi] ?? null;

			let pairRisk: PenaltyComparison["risk"] = "none";
			let pairReason = "";
			let pairDelta: PenaltyComparison["delta"] = null;

			if (cur && prop) {
				pairDelta = {
					minChange: prop.min - cur.min,
					maxChange: prop.max - cur.max,
				};
				if (pairDelta.minChange < 0) {
					pairRisk = "critical";
					pairReason = `BAJADA DE MÍNIMO: de ${cur.min} a ${prop.min} años. Por principio pro reo (art. 2.2 CP), los condenados con penas entre ${prop.min}-${cur.min} años podrían solicitar revisión de condena.`;
				} else if (pairDelta.maxChange < 0) {
					pairRisk = "high";
					pairReason = `Bajada de máximo: de ${cur.max} a ${prop.max} años.`;
				} else if (pairDelta.minChange > 0) {
					pairRisk = "low";
					pairReason = `Subida de mínimo: de ${cur.min} a ${prop.min} años.`;
				}
			} else if (cur && !prop) {
				pairRisk = "critical";
				pairReason = `Pena de prisión eliminada: ${cur.min}-${cur.max} ${cur.unit} desaparece en la nueva redacción.`;
			}

			const riskOrder = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
			if (riskOrder[pairRisk] > riskOrder[worstRisk]) {
				worstRisk = pairRisk;
				worstRiskReason = pairReason;
				worstDelta = pairDelta;
				bestCurrent = cur;
				bestProposed = prop;
			}
		}

		comparisons.push({
			article: `Artículo ${articleNum}`,
			current: bestCurrent,
			proposed: bestProposed,
			delta: worstDelta,
			risk: worstRisk,
			riskReason: worstRiskReason,
		});
	}

	return comparisons;
}

// ── Type elimination detection ──

function detectTypeEliminations(
	db: Database,
	modifications: BillModification[],
	normId: string,
): TypeEliminationAlert[] {
	const alerts: TypeEliminationAlert[] = [];

	for (const mod of modifications) {
		if (mod.changeType !== "suppress_chapter") continue;

		// Find articles in this chapter/title by searching blocks
		// The target is something like "Capítulo I del Título XXII"
		const chapterName = mod.targetProvision;

		// TODO: chapter-to-article mapping requires parent-child block traversal.
		// Check if any articles in this norm have version history
		const hasVersions = db
			.query<{ count: number }, string>(
				`SELECT COUNT(*) as count FROM versions WHERE norm_id = ?`,
			)
			.get(normId);

		alerts.push({
			chapter: chapterName,
			// TODO: chapter-to-article mapping requires parent-child block traversal — returns empty until implemented.
			articlesAffected: [],
			existingConvictions: (hasVersions?.count ?? 0) > 0,
			risk: "critical",
			riskReason: `Eliminación completa de tipo penal (${chapterName}). Condenas existentes deben ser revisadas bajo art. 2.2 CP.`,
		});
	}

	return alerts;
}

// ── Transitional provision check ──

function checkTransitionalProvisions(
	bill: ParsedBill,
	modifiesPenalCode: boolean,
	changesPenalties: boolean,
	eliminatesTypes: boolean,
): TransitionalCheck {
	if (!modifiesPenalCode) {
		return {
			hasPenaltyTransitional: false,
			hasRevisionTransitional: false,
			modifiesPenalCode: false,
			changesPenalties: false,
			eliminatesTypes: false,
			risk: "none",
			message: "No modifica el Código Penal.",
		};
	}

	if (!changesPenalties && !eliminatesTypes) {
		return {
			hasPenaltyTransitional: false,
			hasRevisionTransitional: false,
			modifiesPenalCode: true,
			changesPenalties: false,
			eliminatesTypes: false,
			risk: "none",
			message:
				"Modifica el Código Penal pero no altera penas de prisión ni elimina tipos.",
		};
	}

	const dtText = bill.transitionalProvisions.join("\n");

	// Check for penalty-related transitional provisions
	const penaltyKeywords =
		/(?:pena|condena|sentencia firme|retroactiv|pro reo|favorable|cumplimiento)/i;
	const hasPenaltyTransitional = penaltyKeywords.test(dtText);

	// Check for explicit revision provisions (LO 14/2022 has this)
	const revisionKeywords =
		/(?:revisión de sentencias|revisión de condenas|revisar las sentencias|legislación aplicable)/i;
	const hasRevisionTransitional = revisionKeywords.test(dtText);

	let risk: TransitionalCheck["risk"] = "none";
	let message: string;

	if (eliminatesTypes && !hasRevisionTransitional) {
		risk = "critical";
		message =
			"RIESGO CRÍTICO: Se eliminan tipos penales SIN disposición transitoria de revisión de sentencias. Condenas existentes quedarían sin base legal.";
	} else if (changesPenalties && !hasPenaltyTransitional) {
		risk = "critical";
		message =
			"RIESGO CRÍTICO: Se modifican penas del Código Penal pero NO existe disposición transitoria que regule la aplicación retroactiva (art. 2.2 CP). Los condenados bajo la ley anterior podrían solicitar revisión de condena si los nuevos mínimos son más bajos.";
	} else if (eliminatesTypes && hasRevisionTransitional) {
		risk = "high";
		message =
			"Se eliminan tipos penales. Existe disposición transitoria de revisión de sentencias — verificar que cubre adecuadamente todas las condenas afectadas.";
	} else if (hasPenaltyTransitional) {
		risk = "none";
		message = "Existe disposición transitoria sobre penas/condenas.";
	} else {
		risk = "none";
		message =
			"No se detectaron riesgos críticos en disposiciones transitorias.";
	}

	return {
		hasPenaltyTransitional,
		hasRevisionTransitional,
		modifiesPenalCode,
		changesPenalties,
		eliminatesTypes,
		risk,
		message,
	};
}

// ── Graph traversal — blast radius ──

function findAffectedNorms(
	db: Database,
	normId: string,
	modifiedArticles: string[],
): AffectedNorm[] {
	const refs = db
		.query<{ norm_id: string; relation: string; text: string }, string>(
			`SELECT r.norm_id, r.relation, r.text
			 FROM referencias r
			 WHERE r.target_id = ?
			 AND r.relation IN ('CITA', 'DE CONFORMIDAD con', 'SE DICTA DE CONFORMIDAD', 'SE DESARROLLA')
			 ORDER BY r.relation`,
		)
		.all(normId);

	const normMap = new Map<
		string,
		{ relations: Set<string>; articleRefs: Set<string> }
	>();

	for (const ref of refs) {
		if (!normMap.has(ref.norm_id)) {
			normMap.set(ref.norm_id, {
				relations: new Set(),
				articleRefs: new Set(),
			});
		}
		const entry = normMap.get(ref.norm_id)!;
		entry.relations.add(ref.relation);

		for (const art of modifiedArticles) {
			const artNum = art.match(/\d+/)?.[0];
			if (artNum && ref.text?.includes(`art. ${artNum}`)) {
				entry.articleRefs.add(art);
			}
		}
	}

	// Batch-fetch all norm titles in a single query to avoid N+1
	const normIds = [...normMap.keys()];
	const titleMap = new Map<string, string>();
	if (normIds.length > 0) {
		const placeholders = normIds.map(() => "?").join(", ");
		const rows = db
			.query<{ id: string; title: string }, string[]>(
				`SELECT id, title FROM norms WHERE id IN (${placeholders})`,
			)
			.all(...normIds);
		for (const row of rows) {
			titleMap.set(row.id, row.title);
		}
	}

	const results: AffectedNorm[] = [];
	for (const [nId, data] of normMap) {
		const title = titleMap.get(nId);
		if (title) {
			results.push({
				normId: nId,
				title,
				relation: [...data.relations].join(", "),
				articleRefs: [...data.articleRefs],
			});
		}
	}

	results.sort((a, b) => b.articleRefs.length - a.articleRefs.length);
	return results;
}

// ── Main analyzer ──

export function analyzeBill(db: Database, bill: ParsedBill): ImpactReport {
	const allPenaltyComparisons: PenaltyComparison[] = [];
	const allTypeEliminations: TypeEliminationAlert[] = [];
	const allAffectedNorms: AffectedNorm[] = [];

	const CP_KEYWORDS = ["Código Penal", "10/1995"];

	let modifiesPenalCode = false;

	// Resolve norm IDs and run analysis per group
	for (const group of bill.modificationGroups) {
		group.normId = resolveNormId(db, group.targetLaw) ?? undefined;

		const isCP = CP_KEYWORDS.some(
			(kw) =>
				group.targetLaw.includes(kw) || group.normId === "BOE-A-1995-25444",
		);

		if (isCP) {
			modifiesPenalCode = true;
			const normId = group.normId ?? "BOE-A-1995-25444";

			// Penalty comparison
			const comparisons = comparePenalties(
				db,
				group.modifications,
				normId,
				bill.publicationDate,
			);
			allPenaltyComparisons.push(...comparisons);

			// Type eliminations
			const eliminations = detectTypeEliminations(
				db,
				group.modifications,
				normId,
			);
			allTypeEliminations.push(...eliminations);

			// Blast radius
			const modifiedArticles = group.modifications
				.map((m) => {
					const artMatch = m.targetProvision.match(
						/art[ií]culo (\d+(?:\s*(?:bis|ter|qu[aá]ter))?)/i,
					);
					return artMatch ? `art. ${artMatch[1]}` : null;
				})
				.filter(Boolean) as string[];

			const affected = findAffectedNorms(db, normId, modifiedArticles);
			allAffectedNorms.push(...affected);
		}
	}

	const changesPenalties = allPenaltyComparisons.some((c) => c.risk !== "none");
	const eliminatesTypes = allTypeEliminations.length > 0;

	const transitionalCheck = checkTransitionalProvisions(
		bill,
		modifiesPenalCode,
		changesPenalties,
		eliminatesTypes,
	);

	const criticalAlerts =
		allPenaltyComparisons.filter((c) => c.risk === "critical").length +
		allTypeEliminations.length +
		(transitionalCheck.risk === "critical" ? 1 : 0);

	const highAlerts =
		allPenaltyComparisons.filter((c) => c.risk === "high").length +
		(transitionalCheck.risk === "high" ? 1 : 0);

	return {
		billId: bill.bocgId,
		groups: bill.modificationGroups,
		penaltyAnalysis: allPenaltyComparisons,
		typeEliminations: allTypeEliminations,
		transitionalCheck,
		affectedNorms: allAffectedNorms,
		summary: {
			totalModifications: bill.modificationGroups.reduce(
				(sum, g) => sum + g.modifications.length,
				0,
			),
			lawsModified: bill.modificationGroups.length,
			criticalAlerts,
			highAlerts,
		},
	};
}

// ── Human-readable report ──

export function formatReport(report: ImpactReport): string {
	const lines: string[] = [];

	lines.push("=".repeat(60));
	lines.push(`  BILL IMPACT REPORT: ${report.billId}`);
	lines.push("=".repeat(60));
	lines.push("");

	// Modification groups
	lines.push("-".repeat(60));
	lines.push("  MODIFICATION GROUPS");
	lines.push("-".repeat(60));
	lines.push("");

	for (const group of report.groups) {
		const normTag = group.normId ? ` [${group.normId}]` : " [unresolved]";
		lines.push(`  ${group.title}${normTag}`);
		lines.push(`    Target: ${group.targetLaw}`);
		lines.push(`    Modifications: ${group.modifications.length}`);

		const typeCounts = new Map<string, number>();
		for (const mod of group.modifications) {
			typeCounts.set(mod.changeType, (typeCounts.get(mod.changeType) ?? 0) + 1);
		}
		lines.push(
			`    Types: ${[...typeCounts.entries()].map(([t, c]) => `${t}(${c})`).join(", ")}`,
		);
		lines.push("");
	}

	// Penalty analysis
	if (report.penaltyAnalysis.length > 0) {
		lines.push("-".repeat(60));
		lines.push("  PENALTY ANALYSIS");
		lines.push("-".repeat(60));
		lines.push("");

		for (const comp of report.penaltyAnalysis) {
			if (comp.risk === "none") continue;

			const icon =
				comp.risk === "critical"
					? "[CRITICAL]"
					: comp.risk === "high"
						? "[HIGH]"
						: comp.risk === "medium"
							? "[MEDIUM]"
							: "[LOW]";

			lines.push(`  ${icon} ${comp.article} -- ${comp.risk.toUpperCase()}`);
			if (comp.current) {
				lines.push(
					`    Current:  ${comp.current.min}-${comp.current.max} ${comp.current.unit}`,
				);
			}
			if (comp.proposed) {
				lines.push(
					`    Proposed: ${comp.proposed.min}-${comp.proposed.max} ${comp.proposed.unit}`,
				);
			}
			if (comp.delta) {
				lines.push(
					`    Delta:    min ${comp.delta.minChange > 0 ? "+" : ""}${comp.delta.minChange}, max ${comp.delta.maxChange > 0 ? "+" : ""}${comp.delta.maxChange}`,
				);
			}
			lines.push(`    ${comp.riskReason}`);
			lines.push("");
		}
	}

	// Type eliminations
	if (report.typeEliminations.length > 0) {
		lines.push("-".repeat(60));
		lines.push("  TYPE ELIMINATIONS");
		lines.push("-".repeat(60));
		lines.push("");

		for (const elim of report.typeEliminations) {
			lines.push(`  [CRITICAL] ${elim.chapter}`);
			lines.push(
				`    Existing convictions: ${elim.existingConvictions ? "YES" : "NO"}`,
			);
			lines.push(`    ${elim.riskReason}`);
			lines.push("");
		}
	}

	// Transitional provisions
	lines.push("-".repeat(60));
	lines.push("  TRANSITIONAL PROVISIONS CHECK");
	lines.push("-".repeat(60));
	lines.push("");
	lines.push(
		`  Modifies Penal Code: ${report.transitionalCheck.modifiesPenalCode ? "YES" : "NO"}`,
	);
	lines.push(
		`  Changes penalties: ${report.transitionalCheck.changesPenalties ? "YES" : "NO"}`,
	);
	lines.push(
		`  Eliminates types: ${report.transitionalCheck.eliminatesTypes ? "YES" : "NO"}`,
	);
	lines.push(
		`  Has penalty DT: ${report.transitionalCheck.hasPenaltyTransitional ? "YES" : "NO"}`,
	);
	lines.push(
		`  Has revision DT: ${report.transitionalCheck.hasRevisionTransitional ? "YES" : "NO"}`,
	);
	lines.push(`  Risk: ${report.transitionalCheck.risk.toUpperCase()}`);
	lines.push(`  ${report.transitionalCheck.message}`);
	lines.push("");

	// Blast radius
	if (report.affectedNorms.length > 0) {
		const directlyAffected = report.affectedNorms.filter(
			(n) => n.articleRefs.length > 0,
		);
		lines.push("-".repeat(60));
		lines.push("  BLAST RADIUS");
		lines.push("-".repeat(60));
		lines.push("");
		lines.push(`  ${report.affectedNorms.length} norms reference modified law`);
		lines.push(
			`  ${directlyAffected.length} norms reference specific modified articles`,
		);
		lines.push("");

		for (const norm of directlyAffected.slice(0, 10)) {
			lines.push(`    ${norm.normId}`);
			lines.push(`    ${norm.title.slice(0, 100)}`);
			lines.push(
				`    Refs: ${norm.articleRefs.join(", ")} | Relation: ${norm.relation}`,
			);
			lines.push("");
		}

		if (directlyAffected.length > 10) {
			lines.push(
				`    ... and ${directlyAffected.length - 10} more directly affected norms.`,
			);
			lines.push("");
		}
	}

	// Summary
	lines.push("=".repeat(60));
	lines.push("  SUMMARY");
	lines.push("=".repeat(60));
	lines.push("");
	lines.push(`  Total modifications: ${report.summary.totalModifications}`);
	lines.push(`  Laws modified: ${report.summary.lawsModified}`);
	lines.push(`  Critical alerts: ${report.summary.criticalAlerts}`);
	lines.push(`  High alerts: ${report.summary.highAlerts}`);
	lines.push("");

	// Verdict
	if (report.summary.criticalAlerts > 0) {
		lines.push(
			"  >>> VERDICT: CRITICAL RISK — Review required before approval <<<",
		);
	} else if (report.summary.highAlerts > 0) {
		lines.push("  >>> VERDICT: HIGH RISK — Attention recommended <<<");
	} else {
		lines.push("  >>> VERDICT: OK — No critical issues detected <<<");
	}
	lines.push("");

	return lines.join("\n");
}
