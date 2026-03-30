import { describe, expect, test } from "bun:test";
import type { NormMetadata } from "../src/models.ts";
import { extractJurisdiction, normToFilepath } from "../src/transform/slug.ts";

describe("extractJurisdiction", () => {
	test("extracts state-level jurisdiction from ELI URL", () => {
		const metadata = {
			source: "https://www.boe.es/eli/es/l/2015/10/23/11",
			country: "es",
		} as NormMetadata;
		expect(extractJurisdiction(metadata)).toBe("es");
	});

	test("extracts autonomous community from ELI URL", () => {
		const metadata = {
			source: "https://www.boe.es/eli/es-pv/l/2019/12/20/11",
			country: "es",
		} as NormMetadata;
		expect(extractJurisdiction(metadata)).toBe("es-pv");
	});

	test("extracts Catalonia from ELI URL", () => {
		const metadata = {
			source: "https://www.boe.es/eli/es-ct/l/2017/12/21/18",
			country: "es",
		} as NormMetadata;
		expect(extractJurisdiction(metadata)).toBe("es-ct");
	});

	test("falls back to country when no ELI URL", () => {
		const metadata = {
			id: "BOE-A-2020-1234",
			source: "https://www.boe.es/buscar/act.php?id=BOE-A-2020-1234",
			country: "es",
		} as NormMetadata;
		expect(extractJurisdiction(metadata)).toBe("es");
	});
});

describe("normToFilepath", () => {
	test("generates ELI path for state-level law", () => {
		const metadata = {
			id: "BOE-A-2015-11430",
			source: "https://www.boe.es/eli/es/rdlg/2015/10/23/2",
			country: "es",
		} as NormMetadata;
		expect(normToFilepath(metadata)).toBe("es/BOE-A-2015-11430.md");
	});

	test("generates ELI path for autonomous community law", () => {
		const metadata = {
			id: "BOE-A-2020-615",
			source: "https://www.boe.es/eli/es-pv/l/2019/12/20/11",
			country: "es",
		} as NormMetadata;
		expect(normToFilepath(metadata)).toBe("es-pv/BOE-A-2020-615.md");
	});

	test("generates ELI path for the Constitution", () => {
		const metadata = {
			id: "BOE-A-1978-31229",
			source: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
			country: "es",
		} as NormMetadata;
		expect(normToFilepath(metadata)).toBe("es/BOE-A-1978-31229.md");
	});
});
