/**
 * Unit tests for parseNormReference — issue #128.
 */

import { describe, expect, it } from "bun:test";
import { parseNormReference } from "../services/norm-reference.ts";

describe("parseNormReference — norm IDs", () => {
	it("parses a BOE norm id", () => {
		expect(parseNormReference("BOE-A-2024-26931")).toEqual({
			kind: "id",
			id: "BOE-A-2024-26931",
		});
	});

	it("uppercases a lowercase norm id", () => {
		expect(parseNormReference("boe-a-2024-26931")).toEqual({
			kind: "id",
			id: "BOE-A-2024-26931",
		});
	});

	it("parses a regional bulletin id with a lowercase letter segment", () => {
		expect(parseNormReference("BORM-s-2026-90179")).toEqual({
			kind: "id",
			id: "BORM-S-2026-90179",
		});
	});

	it("parses another regional bulletin format", () => {
		expect(parseNormReference("BOIB-i-2007-90098")).toEqual({
			kind: "id",
			id: "BOIB-I-2007-90098",
		});
	});
});

describe("parseNormReference — ELI URLs", () => {
	it("parses a full ELI URL and derives lookup variants", () => {
		const result = parseNormReference(
			"https://www.boe.es/eli/es/rd/2024/12/23/1312",
		);
		expect(result?.kind).toBe("eli");
		if (result?.kind === "eli") {
			expect(result.urls).toContain(
				"https://www.boe.es/eli/es/rd/2024/12/23/1312",
			);
		}
	});

	it("parses an ELI URL with a trailing slash", () => {
		const result = parseNormReference(
			"https://www.boe.es/eli/es/rd/2024/12/23/1312/",
		);
		expect(result?.kind).toBe("eli");
	});

	it("parses a regional ELI URL", () => {
		const result = parseNormReference(
			"https://www.boe.es/eli/es-an/l/2001/06/04/5",
		);
		expect(result?.kind).toBe("eli");
	});
});

describe("parseNormReference — bare number/year", () => {
	it("parses a bare number/year", () => {
		expect(parseNormReference("1312/2024")).toEqual({
			kind: "number_year",
			number: "1312",
			year: "2024",
		});
	});

	it("tolerates spaces around the slash", () => {
		expect(parseNormReference("1312 / 2024")).toEqual({
			kind: "number_year",
			number: "1312",
			year: "2024",
		});
	});

	it("rejects a bare year with no slash", () => {
		expect(parseNormReference("2024")).toBeNull();
	});

	it("treats a bare BOE sequence number as an id suffix", () => {
		expect(parseNormReference("26931")).toEqual({
			kind: "id_suffix",
			sequence: "26931",
		});
	});

	it("rejects number/year with trailing garbage", () => {
		expect(parseNormReference("1312/2024 de vivienda")).not.toEqual({
			kind: "number_year",
			number: "1312",
			year: "2024",
		});
	});
});

describe("parseNormReference — well-known acronyms", () => {
	it("resolves LAU", () => {
		expect(parseNormReference("LAU")).toEqual({
			kind: "alias",
			id: "BOE-A-1994-26003",
		});
	});

	it("resolves LAU case-insensitively", () => {
		expect(parseNormReference("lau")).toEqual({
			kind: "alias",
			id: "BOE-A-1994-26003",
		});
	});

	it("resolves LEC", () => {
		expect(parseNormReference("LEC")).toEqual({
			kind: "alias",
			id: "BOE-A-2000-323",
		});
	});

	it("resolves LECRIM", () => {
		expect(parseNormReference("LECrim")).toEqual({
			kind: "alias",
			id: "BOE-A-1882-6036",
		});
	});

	it("resolves ET", () => {
		expect(parseNormReference("ET")).toEqual({
			kind: "alias",
			id: "BOE-A-2015-11430",
		});
	});

	it("resolves LGSS", () => {
		expect(parseNormReference("LGSS")).toEqual({
			kind: "alias",
			id: "BOE-A-2015-11724",
		});
	});

	it("resolves LOPDGDD", () => {
		expect(parseNormReference("LOPDGDD")).toEqual({
			kind: "alias",
			id: "BOE-A-2018-16673",
		});
	});

	it("resolves LPACAP", () => {
		expect(parseNormReference("LPACAP")).toEqual({
			kind: "alias",
			id: "BOE-A-2015-10565",
		});
	});

	it("resolves LRJSP", () => {
		expect(parseNormReference("LRJSP")).toEqual({
			kind: "alias",
			id: "BOE-A-2015-10566",
		});
	});

	it("resolves CE (Constitucion)", () => {
		expect(parseNormReference("CE")).toEqual({
			kind: "alias",
			id: "BOE-A-1978-31229",
		});
	});

	it("resolves CC (Codigo Civil)", () => {
		expect(parseNormReference("CC")).toEqual({
			kind: "alias",
			id: "BOE-A-1889-4763",
		});
	});

	it("resolves CP (Codigo Penal)", () => {
		expect(parseNormReference("CP")).toEqual({
			kind: "alias",
			id: "BOE-A-1995-25444",
		});
	});

	it("does not treat an acronym-shaped substring as an alias", () => {
		expect(parseNormReference("la LAU regula el alquiler")).toBeNull();
	});
});

describe("parseNormReference — ranked references (rango + num/año)", () => {
	it("parses 'Real Decreto 1312/2024'", () => {
		expect(parseNormReference("Real Decreto 1312/2024")).toEqual({
			kind: "ranked",
			rank: "real_decreto",
			shortTitle: "Real Decreto 1312/2024",
		});
	});

	it("parses 'RD 1312/2024'", () => {
		expect(parseNormReference("RD 1312/2024")).toEqual({
			kind: "ranked",
			rank: "real_decreto",
			shortTitle: "Real Decreto 1312/2024",
		});
	});

	it("parses 'R.D. 1312/2024'", () => {
		expect(parseNormReference("R.D. 1312/2024")).toEqual({
			kind: "ranked",
			rank: "real_decreto",
			shortTitle: "Real Decreto 1312/2024",
		});
	});

	it("parses 'Ley Organica 3/2018' (no accent)", () => {
		expect(parseNormReference("Ley Organica 3/2018")).toEqual({
			kind: "ranked",
			rank: "ley_organica",
			shortTitle: "Ley Orgánica 3/2018",
		});
	});

	it("parses 'Ley Orgánica 3/2018' (with accent)", () => {
		expect(parseNormReference("Ley Orgánica 3/2018")).toEqual({
			kind: "ranked",
			rank: "ley_organica",
			shortTitle: "Ley Orgánica 3/2018",
		});
	});

	it("parses 'LO 3/2018'", () => {
		expect(parseNormReference("LO 3/2018")).toEqual({
			kind: "ranked",
			rank: "ley_organica",
			shortTitle: "Ley Orgánica 3/2018",
		});
	});

	it("parses 'Real Decreto-ley 8/2015'", () => {
		expect(parseNormReference("Real Decreto-ley 8/2015")).toEqual({
			kind: "ranked",
			rank: "real_decreto_ley",
			shortTitle: "Real Decreto-ley 8/2015",
		});
	});

	it("parses 'RDL 8/2015'", () => {
		expect(parseNormReference("RDL 8/2015")).toEqual({
			kind: "ranked",
			rank: "real_decreto_ley",
			shortTitle: "Real Decreto-ley 8/2015",
		});
	});

	it("parses 'RD-ley 8/2015'", () => {
		expect(parseNormReference("RD-ley 8/2015")).toEqual({
			kind: "ranked",
			rank: "real_decreto_ley",
			shortTitle: "Real Decreto-ley 8/2015",
		});
	});

	it("parses 'Real Decreto Legislativo 8/2015'", () => {
		expect(parseNormReference("Real Decreto Legislativo 8/2015")).toEqual({
			kind: "ranked",
			rank: "real_decreto_legislativo",
			shortTitle: "Real Decreto Legislativo 8/2015",
		});
	});

	it("parses 'RDLeg 8/2015'", () => {
		expect(parseNormReference("RDLeg 8/2015")).toEqual({
			kind: "ranked",
			rank: "real_decreto_legislativo",
			shortTitle: "Real Decreto Legislativo 8/2015",
		});
	});

	it("parses 'Decreto-ley 31/2020'", () => {
		expect(parseNormReference("Decreto-ley 31/2020")).toEqual({
			kind: "ranked",
			rank: "real_decreto_ley",
			shortTitle: "Decreto-ley 31/2020",
		});
	});

	it("parses 'Ley 12/2016'", () => {
		expect(parseNormReference("Ley 12/2016")).toEqual({
			kind: "ranked",
			rank: "ley",
			shortTitle: "Ley 12/2016",
		});
	});

	it("tolerates the full title pasted with 'de DD de mes'", () => {
		expect(
			parseNormReference("Real Decreto 1312/2024, de 23 de diciembre"),
		).toEqual({
			kind: "ranked",
			rank: "real_decreto",
			shortTitle: "Real Decreto 1312/2024",
		});
	});

	it("tolerates multiple spaces", () => {
		expect(parseNormReference("Real   Decreto   1312/2024")).toEqual({
			kind: "ranked",
			rank: "real_decreto",
			shortTitle: "Real Decreto 1312/2024",
		});
	});

	it("is case-insensitive", () => {
		expect(parseNormReference("real decreto 1312/2024")).toEqual({
			kind: "ranked",
			rank: "real_decreto",
			shortTitle: "Real Decreto 1312/2024",
		});
	});
});

describe("parseNormReference — ministerial orders", () => {
	it("parses 'Orden HAP/1370/2014'", () => {
		expect(parseNormReference("Orden HAP/1370/2014")).toEqual({
			kind: "ranked",
			rank: "orden",
			shortTitle: "Orden HAP/1370/2014",
		});
	});

	it("parses 'Orden ETU/615/2017'", () => {
		expect(parseNormReference("Orden ETU/615/2017")).toEqual({
			kind: "ranked",
			rank: "orden",
			shortTitle: "Orden ETU/615/2017",
		});
	});

	it("is case-insensitive on the ministry sigla", () => {
		expect(parseNormReference("orden hap/1370/2014")).toEqual({
			kind: "ranked",
			rank: "orden",
			shortTitle: "Orden HAP/1370/2014",
		});
	});
});

describe("parseNormReference — negative cases", () => {
	it("rejects a rango with no number ('Real Decreto')", () => {
		expect(parseNormReference("Real Decreto")).toBeNull();
	});

	it("rejects a bare rango word ('Ley')", () => {
		expect(parseNormReference("Ley")).toBeNull();
	});

	it("rejects a natural-language query", () => {
		expect(parseNormReference("vivienda")).toBeNull();
	});

	it("rejects a longer natural-language query", () => {
		expect(parseNormReference("permiso de paternidad cuantos dias")).toBeNull();
	});

	it("rejects an empty string", () => {
		expect(parseNormReference("")).toBeNull();
	});

	it("rejects whitespace only", () => {
		expect(parseNormReference("   ")).toBeNull();
	});

	it("rejects 'Orden' with no ministry/number", () => {
		expect(parseNormReference("Orden")).toBeNull();
	});

	it("rejects an unrelated acronym-shaped word", () => {
		expect(parseNormReference("XYZ")).toBeNull();
	});
});

describe("parseNormReference — the 4 reproducible failures from issue #128", () => {
	it("'Real Decreto 1312/2024' resolves to the ranked reference (not BM25 noise)", () => {
		expect(parseNormReference("Real Decreto 1312/2024")).toEqual({
			kind: "ranked",
			rank: "real_decreto",
			shortTitle: "Real Decreto 1312/2024",
		});
	});

	it("'1312/2024' resolves to the bare number/year reference", () => {
		expect(parseNormReference("1312/2024")).toEqual({
			kind: "number_year",
			number: "1312",
			year: "2024",
		});
	});

	it("'26931' resolves as an id suffix (BOE-A-2024-26931)", () => {
		expect(parseNormReference("26931")).toEqual({
			kind: "id_suffix",
			sequence: "26931",
		});
	});

	it("a 4-digit year is NOT treated as a sequence number", () => {
		// "2024" must stay a normal text search — it is overwhelmingly more
		// likely to be a year than the tail of an id.
		expect(parseNormReference("2024")).toBeNull();
		expect(parseNormReference("1978")).toBeNull();
	});

	it("a 4-digit number outside the year range IS a sequence", () => {
		expect(parseNormReference("4763")).toEqual({
			kind: "id_suffix",
			sequence: "4763",
		});
	});

	it("runs of 1-2 digits are too ambiguous to resolve", () => {
		expect(parseNormReference("7")).toBeNull();
		expect(parseNormReference("42")).toBeNull();
	});

	it("'LAU' resolves to the correct alias, not the 1943 university law", () => {
		const result = parseNormReference("LAU");
		expect(result).toEqual({ kind: "alias", id: "BOE-A-1994-26003" });
		expect(result).not.toEqual({ kind: "alias", id: "BOE-A-1943-7181" });
	});
});
