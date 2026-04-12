/**
 * Bill Parser test suite.
 *
 * Tests the parser against real BOCG PDFs to ensure no regressions.
 * PDFs are in data/spike-bills/ (gitignored). Tests are skipped if PDFs are missing.
 *
 * To download all test PDFs, run the benchmark first:
 *   bun run packages/api/src/scripts/spike-bill-benchmark.ts
 *
 * These tests run WITHOUT LLM (deterministic only) so they are free and fast.
 */

import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	extractTextFromPdf,
	parseBill,
	type ParsedBill,
} from "../services/bill-parser/parser.ts";

// ── Test case definitions ──

interface BillExpectation {
	id: string;
	description: string;
	groups: number;
	minMods: number;
	maxMods: number;
	transitionalProvisions: number;
	/** Per-group expectations: [targetLawSubstring, minMods, expectedChangeTypes] */
	groupChecks: Array<{
		targetLaw: string;
		minMods: number;
		changeTypes: string[];
	}>;
	/** Groups that should NOT appear (false positive checks) */
	forbiddenGroups?: string[];
}

const BILLS: BillExpectation[] = [
	{
		id: "BOCG-14-A-62-1",
		description: "LO 10/2022 — Solo sí es sí (libertad sexual)",
		groups: 14,
		minMods: 90,
		maxMods: 110,
		transitionalProvisions: 6,
		groupChecks: [
			{
				targetLaw: "Código Penal",
				minMods: 20,
				changeTypes: ["modify", "add", "delete"],
			},
			{
				targetLaw: "Ley de Enjuiciamiento Criminal",
				minMods: 3,
				changeTypes: ["modify"],
			},
			{
				targetLaw: "Estatuto de la víctima",
				minMods: 5,
				changeTypes: ["modify"],
			},
		],
		forbiddenGroups: [],
	},
	{
		id: "BOCG-10-A-66-1",
		description: "LO 1/2015 — Reforma masiva del CP (240+ artículos)",
		groups: 4,
		minMods: 220,
		maxMods: 240,
		transitionalProvisions: 4,
		groupChecks: [
			{
				targetLaw: "Código Penal",
				minMods: 190,
				changeTypes: ["modify", "add", "suppress_chapter"],
			},
			{
				targetLaw: "Poder Judicial",
				minMods: 1,
				changeTypes: ["add"],
			},
		],
		forbiddenGroups: [],
	},
	{
		id: "BOCG-14-B-295-1",
		description: "LO 14/2022 — Sedición, malversación, transposición UE",
		groups: 3,
		minMods: 18,
		maxMods: 25,
		transitionalProvisions: 3,
		groupChecks: [
			{
				targetLaw: "Código Penal",
				minMods: 15,
				changeTypes: ["modify", "add", "suppress_chapter"],
			},
		],
		forbiddenGroups: [],
	},
	{
		id: "BOCG-14-A-116-1",
		description: "Eficiencia Digital de Justicia — 7 DFs, DAs inside «» should not be detected",
		groups: 7,
		minMods: 50,
		maxMods: 58,
		transitionalProvisions: 2,
		groupChecks: [
			{
				targetLaw: "Enjuiciamiento Civil",
				minMods: 28,
				changeTypes: ["modify", "add", "delete"],
			},
			{
				targetLaw: "Enjuiciamiento Criminal",
				minMods: 3,
				changeTypes: ["modify"],
			},
			{
				targetLaw: "Jurisdicción Voluntaria",
				minMods: 3,
				changeTypes: ["modify"],
			},
			{
				targetLaw: "jurisdicción social",
				minMods: 5,
				changeTypes: ["modify"],
			},
		],
		// These DAs appear inside «» (proposed LEC text) and must NOT be detected as groups
		forbiddenGroups: [
			"antecedentes por medios electrónicos",
			"gestión procesal",
			"Funciones procesales",
			"soluciones tecnológicas",
		],
	},
	{
		id: "BOCG-15-A-2-1",
		// Note: parser extracts BOCG-15-A-2-1 from CVE or fallback to roman numeral conversion
		description: "Presupuestos 2023 — omnibus with many DFs",
		groups: 17,
		minMods: 160,
		maxMods: 185,
		transitionalProvisions: 12,
		groupChecks: [],
		forbiddenGroups: [],
	},
	{
		id: "BOCG-15-A-3-1",
		description: "Acompañamiento presupuestos — omnibus catch-all",
		groups: 31,
		minMods: 55,
		maxMods: 75,
		transitionalProvisions: 12,
		groupChecks: [],
		forbiddenGroups: [],
	},
	{
		id: "BOCG-15-B-23-1",
		description: "Proposición — artículo-based groups",
		groups: 7,
		minMods: 7,
		maxMods: 12,
		transitionalProvisions: 0,
		groupChecks: [],
		forbiddenGroups: [],
	},
];

// ── Helpers ──

import { join } from "node:path";

// Resolve PDF dir: works both from packages/api/ (normal bun test) and repo root
// import.meta.dir = .../packages/api/src/__tests__ → go up 4 levels to repo root
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PDF_DIR = join(REPO_ROOT, "data", "spike-bills");

function hasPdf(id: string): boolean {
	return existsSync(join(PDF_DIR, `${id}.PDF`));
}


const parsedCache = new Map<string, ParsedBill>();

// Use Promise cache to prevent parallel parses of the same bill
const parsePromises = new Map<string, Promise<ParsedBill>>();

async function getParsed(id: string): Promise<ParsedBill> {
	if (parsedCache.has(id)) return parsedCache.get(id)!;

	// Deduplicate concurrent requests for the same bill
	if (parsePromises.has(id)) return parsePromises.get(id)!;

	const promise = (async () => {
		const pdfPath = join(PDF_DIR, `${id}.PDF`);
		const text = extractTextFromPdf(pdfPath);
		const parsed = await parseBill(text);
		parsedCache.set(id, parsed);
		parsePromises.delete(id);
		return parsed;
	})();

	parsePromises.set(id, promise);
	return promise;
}

// ── Tests ──

describe("bill-parser", () => {
	for (const bill of BILLS) {
		describe(bill.id, () => {
			const skip = !hasPdf(bill.id);

			test.skipIf(skip)(
				`${bill.description}: detects ${bill.groups} groups`,
				async () => {
					const parsed = await getParsed(bill.id);
					expect(parsed.modificationGroups.length).toBe(bill.groups);
				},
			);

			test.skipIf(skip)(
				"total modifications within expected range",
				async () => {
					const parsed = await getParsed(bill.id);
					const totalMods = parsed.modificationGroups.reduce(
						(s, g) => s + g.modifications.length,
						0,
					);
					expect(totalMods).toBeGreaterThanOrEqual(bill.minMods);
					expect(totalMods).toBeLessThanOrEqual(bill.maxMods);
				},
			);

			test.skipIf(skip)(
				`detects ${bill.transitionalProvisions} transitional provisions`,
				async () => {
					const parsed = await getParsed(bill.id);
					expect(parsed.transitionalProvisions.length).toBe(
						bill.transitionalProvisions,
					);
				},
			);

			test.skipIf(skip)(
				"extracts BOCG ID correctly",
				async () => {
					const parsed = await getParsed(bill.id);
					expect(parsed.bocgId).toBe(bill.id);
				},
			);

			test.skipIf(skip)(
				"extracts publication date",
				async () => {
					const parsed = await getParsed(bill.id);
					expect(parsed.publicationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
					expect(parsed.publicationDate).not.toBe("unknown");
				},
			);

			test.skipIf(skip)(
				"zero warnings (all modifications classified)",
				async () => {
					const parsed = await getParsed(bill.id);
					for (const group of parsed.modificationGroups) {
						for (const mod of group.modifications) {
							expect(mod.changeType).not.toBe("unknown");
						}
					}
				},
			);

			// Per-group checks
			for (const check of bill.groupChecks) {
				test.skipIf(skip)(
					`group "${check.targetLaw}" has >= ${check.minMods} mods with types [${check.changeTypes.join(", ")}]`,
					async () => {
						const parsed = await getParsed(bill.id);
						const matching = parsed.modificationGroups.filter((g) =>
							g.targetLaw.includes(check.targetLaw),
						);
						expect(matching.length).toBeGreaterThanOrEqual(1);

						const totalMods = matching.reduce(
							(s, g) => s + g.modifications.length,
							0,
						);
						expect(totalMods).toBeGreaterThanOrEqual(check.minMods);

						const foundTypes = new Set<string>(
							matching.flatMap((g) =>
								g.modifications.map((m) => m.changeType),
							),
						);
						for (const expectedType of check.changeTypes) {
							expect(foundTypes.has(expectedType)).toBe(true);
						}
					},
				);
			}

			// Forbidden group checks (false positive detection)
			for (const forbidden of bill.forbiddenGroups ?? []) {
				test.skipIf(skip)(
					`no false positive group containing "${forbidden}"`,
					async () => {
						const parsed = await getParsed(bill.id);
						const found = parsed.modificationGroups.filter(
							(g) =>
								g.targetLaw.includes(forbidden) ||
								g.title.includes(forbidden),
						);
						expect(found.length).toBe(0);
					},
				);
			}
		});
	}

	// Cross-cutting tests
	describe("cross-cutting", () => {
		const anyPdfAvailable = BILLS.some((b) => hasPdf(b.id));

		test.skipIf(!anyPdfAvailable)(
			"no group has empty target law",
			async () => {
				for (const bill of BILLS) {
					if (!hasPdf(bill.id)) continue;
					const parsed = await getParsed(bill.id);
					for (const group of parsed.modificationGroups) {
						expect(group.targetLaw).not.toBe("");
						expect(group.targetLaw).not.toBe("unknown");
					}
				}
			},
		);

		test.skipIf(!anyPdfAvailable)(
			"no group has empty title",
			async () => {
				for (const bill of BILLS) {
					if (!hasPdf(bill.id)) continue;
					const parsed = await getParsed(bill.id);
					for (const group of parsed.modificationGroups) {
						expect(group.title.length).toBeGreaterThan(0);
					}
				}
			},
		);

		test.skipIf(!anyPdfAvailable)(
			"all modifications have non-empty ordinals",
			async () => {
				for (const bill of BILLS) {
					if (!hasPdf(bill.id)) continue;
					const parsed = await getParsed(bill.id);
					for (const group of parsed.modificationGroups) {
						for (const mod of group.modifications) {
							expect(mod.ordinal).not.toBe("");
						}
					}
				}
			},
		);
	});

	// Bill type classification tests
	describe("bill type", () => {
		const hasA62 = hasPdf("BOCG-14-A-62-1");
		const hasA94 = hasPdf("BOCG-14-A-94-1");
		const anyPdfAvailable = BILLS.some((b) => hasPdf(b.id));

		test.skipIf(!hasA62)(
			"BOCG-14-A-62-1 (solo sí es sí) is mixed (articulado + DFs)",
			async () => {
				const parsed = await getParsed("BOCG-14-A-62-1");
				expect(parsed.billType).toBe("mixed");
			},
		);

		test.skipIf(!hasA94)(
			"BOCG-14-A-94-1 (precursores explosivos) is new_law",
			async () => {
				const parsed = await getParsed("BOCG-14-A-94-1");
				expect(parsed.billType).toBe("new_law");
			},
		);

		test.skipIf(!anyPdfAvailable)(
			"all bills have a valid billType",
			async () => {
				for (const bill of BILLS) {
					if (!hasPdf(bill.id)) continue;
					const parsed = await getParsed(bill.id);
					expect(["new_law", "amendment", "mixed"]).toContain(parsed.billType);
				}
			},
		);
	});

	// New entities tests
	describe("new entities", () => {
		const hasA116 = hasPdf("BOCG-14-A-116-1");
		const hasA94 = hasPdf("BOCG-14-A-94-1");
		const anyPdfAvailable = BILLS.some((b) => hasPdf(b.id));

		test.skipIf(!hasA116)(
			"BOCG-14-A-116-1 detects new entities from articulado",
			async () => {
				const parsed = await getParsed("BOCG-14-A-116-1");
				expect(parsed.newEntities.length).toBeGreaterThanOrEqual(10);
			},
		);

		test.skipIf(!hasA116)(
			"BOCG-14-A-116-1 detects Carpeta Justicia",
			async () => {
				const parsed = await getParsed("BOCG-14-A-116-1");
				const carpeta = parsed.newEntities.find((e) =>
					e.name.toLowerCase().includes("carpeta"),
				);
				expect(carpeta).toBeDefined();
				expect(carpeta!.entityType).toBe("sistema");
			},
		);

		test.skipIf(!hasA116)(
			"BOCG-14-A-116-1 detects Registro Electrónico",
			async () => {
				const parsed = await getParsed("BOCG-14-A-116-1");
				const registro = parsed.newEntities.find((e) =>
					e.name.toLowerCase().includes("registro electrónico"),
				);
				expect(registro).toBeDefined();
				expect(registro!.entityType).toBe("registro");
			},
		);

		test.skipIf(!hasA116)(
			"BOCG-14-A-116-1 detects Punto Común de Actos de Comunicación",
			async () => {
				const parsed = await getParsed("BOCG-14-A-116-1");
				const punto = parsed.newEntities.find((e) =>
					e.name.toLowerCase().includes("punto común"),
				);
				expect(punto).toBeDefined();
				expect(punto!.entityType).toBe("organo");
			},
		);

		test.skipIf(!hasA94)(
			"BOCG-14-A-94-1 detects >= 1 entity (Punto de Contacto Nacional)",
			async () => {
				const parsed = await getParsed("BOCG-14-A-94-1");
				expect(parsed.newEntities.length).toBeGreaterThanOrEqual(1);
				const punto = parsed.newEntities.find((e) =>
					e.name.toLowerCase().includes("punto de contacto nacional"),
				);
				expect(punto).toBeDefined();
				expect(punto!.entityType).toBe("organo");
			},
		);

		test.skipIf(!anyPdfAvailable)(
			"newEntities is always an array for all bills",
			async () => {
				for (const bill of BILLS) {
					if (!hasPdf(bill.id)) continue;
					const parsed = await getParsed(bill.id);
					expect(Array.isArray(parsed.newEntities)).toBe(true);
				}
			},
		);

		// Pure modification bills should have 0 entities (no articulado principal)
		const PURE_MOD_BILLS = [
			"BOCG-14-A-62-1",
			"BOCG-10-A-66-1",
			"BOCG-14-B-295-1",
			"BOCG-15-B-23-1",
		];
		for (const id of PURE_MOD_BILLS) {
			test.skipIf(!hasPdf(id))(
				`${id} has 0 entities (pure modification bill)`,
				async () => {
					const parsed = await getParsed(id);
					expect(parsed.newEntities.length).toBe(0);
				},
			);
		}
	});

	// Derogation tests
	describe("derogations", () => {
		const hasA116 = hasPdf("BOCG-14-A-116-1");
		const hasA7 = hasPdf("BOCG-14-A-7-1");

		test.skipIf(!hasA116)(
			"BOCG-14-A-116-1 has at least 1 derogation",
			async () => {
				const parsed = await getParsed("BOCG-14-A-116-1");
				expect(parsed.derogations.length).toBeGreaterThanOrEqual(1);
			},
		);

		test.skipIf(!hasA116)(
			"BOCG-14-A-116-1 derogates Ley 18/2011 (full)",
			async () => {
				const parsed = await getParsed("BOCG-14-A-116-1");
				const ley18 = parsed.derogations.find((d) =>
					d.targetLaw.includes("18/2011"),
				);
				expect(ley18).toBeDefined();
				expect(ley18!.scope).toBe("full");
			},
		);

		test.skipIf(!hasA116)(
			"generic derogation clauses are NOT included",
			async () => {
				const parsed = await getParsed("BOCG-14-A-116-1");
				for (const derog of parsed.derogations) {
					expect(derog.text).not.toMatch(
						/cuantas?\s+disposiciones?\s+de\s+igual\s+o\s+inferior\s+rango/i,
					);
				}
			},
		);

		test.skipIf(!hasA7)(
			"BOCG-14-A-7-1 (LOMLOE) detects 2 derogations",
			async () => {
				const parsed = await getParsed("BOCG-14-A-7-1");
				expect(parsed.derogations.length).toBe(2);
			},
		);

		test.skipIf(!hasA7)(
			"BOCG-14-A-7-1 derogates Ley Orgánica 8/2013 (full)",
			async () => {
				const parsed = await getParsed("BOCG-14-A-7-1");
				const lomce = parsed.derogations.find((d) =>
					d.targetLaw.includes("8/2013"),
				);
				expect(lomce).toBeDefined();
				expect(lomce!.scope).toBe("full");
			},
		);

		test.skipIf(!hasA7)(
			"BOCG-14-A-7-1 derogates Real Decreto-ley 5/2016 (full, masculine form)",
			async () => {
				const parsed = await getParsed("BOCG-14-A-7-1");
				const rdl = parsed.derogations.find((d) =>
					d.targetLaw.includes("5/2016"),
				);
				expect(rdl).toBeDefined();
				expect(rdl!.scope).toBe("full");
			},
		);

		// Partial derogation tests (numbered items + "se suprime" + lettered items)
		const hasA66 = hasPdf("BOCG-10-A-66-1");
		const hasA35_15 = hasPdf("BOCG-15-A-35-1");

		test.skipIf(!hasA66)(
			"BOCG-10-A-66-1 detects >= 3 derogations (libro III CP, artículos CP, art. 24 Ley 4/2010)",
			async () => {
				const parsed = await getParsed("BOCG-10-A-66-1");
				expect(parsed.derogations.length).toBeGreaterThanOrEqual(3);
			},
		);

		test.skipIf(!hasA66)(
			"BOCG-10-A-66-1 derogates libro III of Código Penal (partial)",
			async () => {
				const parsed = await getParsed("BOCG-10-A-66-1");
				const libroCP = parsed.derogations.find(
					(d) => d.targetLaw.includes("10/1995") && d.targetProvisions.some((p) => p.includes("libro")),
				);
				expect(libroCP).toBeDefined();
				expect(libroCP!.scope).toBe("partial");
			},
		);

		test.skipIf(!hasA66)(
			"BOCG-10-A-66-1 derogates artículos of Código Penal (partial)",
			async () => {
				const parsed = await getParsed("BOCG-10-A-66-1");
				const articulosCP = parsed.derogations.find(
					(d) =>
						d.targetLaw.includes("10/1995") &&
						d.targetProvisions.some((p) => p.includes("artículo 89")),
				);
				expect(articulosCP).toBeDefined();
				expect(articulosCP!.scope).toBe("partial");
			},
		);

		test.skipIf(!hasA66)(
			"BOCG-10-A-66-1 handles 'Se suprime' as derogation",
			async () => {
				const parsed = await getParsed("BOCG-10-A-66-1");
				const suprime = parsed.derogations.find((d) =>
					d.targetProvisions.some((p) => p.includes("título")),
				);
				expect(suprime).toBeDefined();
				expect(suprime!.scope).toBe("partial");
			},
		);

		test.skipIf(!hasA66)(
			"BOCG-10-A-66-1 derogates artículo 24 of Ley 4/2010 (partial)",
			async () => {
				const parsed = await getParsed("BOCG-10-A-66-1");
				const ley4 = parsed.derogations.find((d) => d.targetLaw.includes("4/2010"));
				expect(ley4).toBeDefined();
				expect(ley4!.scope).toBe("partial");
				expect(ley4!.targetProvisions.some((p) => p.includes("artículo 24"))).toBe(true);
			},
		);

		test.skipIf(!hasA35_15)(
			"BOCG-15-A-35-1 detects >= 1 derogation (artículos de Ley 3/2013)",
			async () => {
				const parsed = await getParsed("BOCG-15-A-35-1");
				expect(parsed.derogations.length).toBeGreaterThanOrEqual(1);
				const ley3 = parsed.derogations.find((d) => d.targetLaw.includes("3/2013"));
				expect(ley3).toBeDefined();
				expect(ley3!.scope).toBe("partial");
			},
		);
	});
});
