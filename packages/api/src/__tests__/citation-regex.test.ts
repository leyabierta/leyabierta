/**
 * Tests for the citation parsing regex from AskChat.tsx.
 * Extracts and tests CITE_RE independently.
 */

import { describe, expect, test } from "bun:test";

// Replicate the exact regex from AskChat.tsx
const CITE_RE =
	/\[([A-Z]{2,5}-[A-Za-z]-\d{4}-\d+),\s*(Art(?:iculo|\.)\s*\d+(?:\.\d+)?(?:\s*(?:bis|ter|quater|quinquies|sexies|septies))?[^[\]]*?)\]/g;

function findCitations(text: string): Array<{ normId: string; articleRef: string }> {
	const results: Array<{ normId: string; articleRef: string }> = [];
	CITE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = CITE_RE.exec(text)) !== null) {
		results.push({ normId: match[1]!, articleRef: match[2]! });
	}
	return results;
}

describe("CITE_RE (citation regex)", () => {
	test("standard BOE citation: [BOE-A-2024-12345, Articulo 38]", () => {
		const text = "Tienes derecho a vacaciones [BOE-A-2024-12345, Articulo 38].";
		const cites = findCitations(text);
		expect(cites).toHaveLength(1);
		expect(cites[0]!.normId).toBe("BOE-A-2024-12345");
		expect(cites[0]!.articleRef).toBe("Articulo 38");
	});

	test("regional ID: [BOA-d-2024-12345, Articulo 5]", () => {
		const text = "Segun la norma [BOA-d-2024-12345, Articulo 5] se establece.";
		const cites = findCitations(text);
		expect(cites).toHaveLength(1);
		expect(cites[0]!.normId).toBe("BOA-d-2024-12345");
		expect(cites[0]!.articleRef).toBe("Articulo 5");
	});

	test("with bis suffix: [BOE-A-1995-7730, Articulo 38 bis]", () => {
		const text = "Establecido en [BOE-A-1995-7730, Articulo 38 bis].";
		const cites = findCitations(text);
		expect(cites).toHaveLength(1);
		expect(cites[0]!.normId).toBe("BOE-A-1995-7730");
		expect(cites[0]!.articleRef).toBe("Articulo 38 bis");
	});

	test("with article subsection: [BOE-A-1995-7730, Art. 38.1]", () => {
		const text = "Dice el [BOE-A-1995-7730, Art. 38.1] que si.";
		const cites = findCitations(text);
		expect(cites).toHaveLength(1);
		expect(cites[0]!.normId).toBe("BOE-A-1995-7730");
		expect(cites[0]!.articleRef).toBe("Art. 38.1");
	});

	test("no citations in text returns no matches", () => {
		const text = "Este texto no tiene ninguna referencia legal.";
		const cites = findCitations(text);
		expect(cites).toHaveLength(0);
	});

	test("multiple citations in one paragraph", () => {
		const text =
			"Vacaciones [BOE-A-1995-7730, Articulo 38] y despido [BOE-A-1995-7730, Articulo 55].";
		const cites = findCitations(text);
		expect(cites).toHaveLength(2);
		expect(cites[0]!.articleRef).toBe("Articulo 38");
		expect(cites[1]!.articleRef).toBe("Articulo 55");
	});

	test("malformed brackets produce no match", () => {
		const cases = [
			"[BOE-A-2024-12345 Articulo 38]", // missing comma
			"[BOE-2024-12345, Articulo 38]", // missing letter segment
			"[12345, Articulo 38]", // no prefix
			"BOE-A-2024-12345, Articulo 38", // no brackets
			"[BOE-A-2024-12345, 38]", // no Art/Articulo
		];
		for (const text of cases) {
			const cites = findCitations(text);
			expect(cites).toHaveLength(0);
		}
	});

	test("with ter suffix: [BOE-A-1995-7730, Articulo 12 ter]", () => {
		const text = "Regulado en [BOE-A-1995-7730, Articulo 12 ter].";
		const cites = findCitations(text);
		expect(cites).toHaveLength(1);
		expect(cites[0]!.articleRef).toBe("Articulo 12 ter");
	});
});
