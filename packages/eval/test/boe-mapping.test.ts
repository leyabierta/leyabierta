/**
 * Table-driven tests for mapCitation / mapCitations.
 * Uses the real leyabierta.db (read-only). If DB is absent the tests are skipped.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mapCitation, mapCitations } from "../src/boe-mapping.ts";

const DB_PATH = join(import.meta.dir, "../../../data/leyabierta.db");

// These tests query the real leyabierta.db (24 GB, gitignored — present on the
// server and in a full local checkout, absent in fresh worktrees/CI). Skip
// cleanly when it isn't there rather than throwing in beforeAll, which would
// fail the whole suite (and block the pre-push hook) for an environmental
// reason unrelated to the code under test.
const DB_AVAILABLE = existsSync(DB_PATH);

let db: Database;

beforeAll(() => {
	if (DB_AVAILABLE) db = new Database(DB_PATH, { readonly: true });
});

afterAll(() => {
	db?.close();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function opts() {
	return { db };
}

// ---------------------------------------------------------------------------
// Cases: [description, rawInput, expectedBoeId, expectedConfidence]
// ---------------------------------------------------------------------------
const cases: Array<[string, string, string | null, string]> = [
	// Alias / canonical
	["CE alias", "CE", "BOE-A-1978-31229", "exact"],
	["Constitución alias", "Constitución", "BOE-A-1978-31229", "exact"],
	[
		"Constitución Española alias",
		"Constitución Española",
		"BOE-A-1978-31229",
		"exact",
	],
	["LIVA alias", "LIVA", "BOE-A-1992-28740", "exact"],
	["LIRPF alias", "LIRPF", "BOE-A-2006-20764", "exact"],
	["LGT alias", "LGT", "BOE-A-2003-23186", "exact"],
	["ET alias", "ET", "BOE-A-2015-11430", "exact"],
	[
		"Estatuto de los Trabajadores",
		"Estatuto de los Trabajadores",
		"BOE-A-2015-11430",
		"exact",
	],

	// Ley N/YYYY — exact and with trailing punctuation/art ref
	["Ley 37/1992", "Ley 37/1992", "BOE-A-1992-28740", "exact"],
	[
		"Ley 37/1992 with article ref",
		"Ley 37/1992 art. 90-",
		"BOE-A-1992-28740",
		"exact",
	],
	[
		"Ley 37/1992 with trailing comma",
		"Ley 37/1992, Art. 22-",
		"BOE-A-1992-28740",
		"exact",
	],
	["Ley 35/2006", "Ley 35/2006", "BOE-A-2006-20764", "exact"],
	["Ley 30/1992", "Ley 30/1992", "BOE-A-1992-26318", "exact"],

	// 2-digit year normalisation
	["Ley 30/92 (2-digit year)", "Ley 30/92", "BOE-A-1992-26318", "exact"],
	// Ley 4/1999 has multiple matches (different autonomous community laws) → ambiguous
	["Ley 4/99 (2-digit year, ambiguous)", "Ley 4/99", null, "ambiguous"],

	// Thousands separator in number ("1.175/1990")
	[
		"RDLeg 1.175/1990 thousands sep",
		"RDLeg. 1175/1990",
		"BOE-A-1990-23930",
		"exact",
	],

	// Ley Orgánica variants
	["Ley Orgánica 4/2000", "Ley Orgánica 4/2000", "BOE-A-2000-544", "exact"],
	["LO 4/2000", "LO 4/2000", "BOE-A-2000-544", "exact"],

	// Real Decreto
	[
		"Real Decreto 203/1995",
		"Real Decreto 203/1995",
		"BOE-A-1995-5542",
		"exact",
	],
	["RD 203/1995", "RD 203/1995", "BOE-A-1995-5542", "exact"],
	[
		"Real Decreto with non-breaking space",
		"Real Decreto 203/1995",
		"BOE-A-1995-5542",
		"exact",
	],

	// Real Decreto Legislativo
	["RDLeg 2/2015", "RDLeg 2/2015", "BOE-A-2015-11430", "exact"],
	[
		"Real Decreto Legislativo 1175/1990",
		"Real Decreto Legislativo 1175/1990",
		"BOE-A-1990-23930",
		"exact",
	],

	// Real Decreto-Ley
	["RDL 3/2004", "RDL 3/2004", "BOE-A-2004-12010", "exact"],

	// Newline in citation
	["Ley with newline", "Ley\n30/1992", "BOE-A-1992-26318", "exact"],

	// Trailing period stripped
	["Ley with trailing period", "Ley 37/1992.", "BOE-A-1992-28740", "exact"],

	// No match cases
	["garbage string", "Ley N", null, "none"],
	["Reglamento noise", "Reglamento. 2.", null, "none"],
	["completely invalid", "foo bar", null, "none"],

	// Case insensitivity
	["LO uppercase", "LO 1/1982", "BOE-A-1982-11196", "exact"],

	// ---------------------------------------------------------------------------
	// Regression: Opus-verified collapsing cases (2026-05-13)
	// These laws were previously incorrectly collapsing to the same BOE-A target.
	// The mapper must return null (not a wrong target) when a law is absent from DB.
	// ---------------------------------------------------------------------------

	// RD 2402/1985 — old Reglamento de Facturas (derogated, not in DB)
	// Must NOT map to BOE-A-1992-28740 (Ley IVA) or any other law.
	["RD 2402/1985 not in DB — must be null", "RD 2402/1985", null, "none"],
	[
		"Real Decreto 2402/1985 not in DB — must be null",
		"Real Decreto 2402/1985",
		null,
		"none",
	],

	// RD 1624/1992 — IVA Reglamento, separate from Ley IVA 37/1992
	// Must map to BOE-A-1992-28925, NOT to BOE-A-1992-28740 (Ley IVA).
	[
		"RD 1624/1992 maps to BOE-A-1992-28925 not to Ley IVA",
		"RD 1624/1992",
		"BOE-A-1992-28925",
		"exact",
	],
	[
		"RD 1624/1992 with article ref still distinct from Ley IVA",
		"RD 1624/1992 art. 79",
		"BOE-A-1992-28925",
		"exact",
	],

	// Ley 43/1995 — Impuesto de Sociedades (old LIS, derogated, not in DB)
	// Must NOT map to BOE-A-1992-28740 (Ley IVA) or any other law.
	["Ley 43/1995 not in DB — must be null", "Ley 43/1995", null, "none"],
	[
		"Ley 43/1995 with article not in DB — must be null",
		"Ley 43/1995 art. 10",
		null,
		"none",
	],

	// Ley 18/1991 — old IRPF (derogated, not in DB)
	// Must NOT map to BOE-A-1996-29117 (Ley 13/1996, unrelated) or any other law.
	["Ley 18/1991 not in DB — must be null", "Ley 18/1991", null, "none"],
	[
		"Ley 18/1991 with article not in DB — must be null",
		"Ley 18/1991 art. 43",
		null,
		"none",
	],

	// Ley 20/1990 — Cooperativas (in DB, must map correctly)
	[
		"Ley 20/1990 cooperativas maps correctly",
		"Ley 20/1990",
		"BOE-A-1990-30735",
		"exact",
	],
];

describe.skipIf(!DB_AVAILABLE)("mapCitation", () => {
	for (const [desc, raw, expectedId, expectedConf] of cases) {
		test(desc, () => {
			const result = mapCitation(raw, opts());
			if (expectedConf === "none") {
				// Expect no match
				expect(result.boe_a_id).toBeNull();
				expect(result.confidence).toBe("none");
			} else if (expectedConf === "ambiguous") {
				// Expect ambiguous: boe_a_id is a best-guess (non-null), confidence is ambiguous
				expect(result.confidence).toBe("ambiguous");
				expect(result.boe_a_id).not.toBeNull();
				expect(result.candidates).toBeDefined();
			} else {
				// Expect a specific ID
				expect(result.boe_a_id).toBe(expectedId);
				expect(["exact", "fuzzy"]).toContain(result.confidence);
			}
		});
	}
});

describe.skipIf(!DB_AVAILABLE)("mapCitations", () => {
	test("processes array of citations", () => {
		const results = mapCitations(
			["Ley 37/1992", "CE", "Ley Orgánica 4/2000"],
			opts(),
		);
		expect(results).toHaveLength(3);
		expect(results[0]!.boe_a_id).toBe("BOE-A-1992-28740");
		expect(results[1]!.boe_a_id).toBe("BOE-A-1978-31229");
		expect(results[2]!.boe_a_id).toBe("BOE-A-2000-544");
	});

	test("handles empty array", () => {
		expect(mapCitations([], opts())).toEqual([]);
	});

	test("preserves raw field verbatim", () => {
		const raw = "  Ley 37/1992, Art. 22-  ";
		const [result] = mapCitations([raw], opts());
		expect(result!.raw).toBe(raw);
	});
});
