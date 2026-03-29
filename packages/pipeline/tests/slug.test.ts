import { describe, expect, test } from "bun:test";
import type { NormMetadata } from "../src/models.ts";
import { normToFilepath, rankToFolder } from "../src/transform/slug.ts";

describe("rankToFolder", () => {
	test("maps known Spanish ranks", () => {
		expect(rankToFolder("constitucion")).toBe("constituciones");
		expect(rankToFolder("ley")).toBe("leyes");
		expect(rankToFolder("ley_organica")).toBe("leyes-organicas");
		expect(rankToFolder("real_decreto")).toBe("reales-decretos");
		expect(rankToFolder("orden")).toBe("ordenes");
	});

	test("returns 'otros' for unknown ranks", () => {
		expect(rankToFolder("unknown_rank")).toBe("otros");
	});
});

describe("normToFilepath", () => {
	test("generates correct path for a law", () => {
		const metadata = {
			id: "BOE-A-2015-11430",
			rank: "ley",
		} as NormMetadata;

		expect(normToFilepath(metadata)).toBe("leyes/BOE-A-2015-11430.md");
	});

	test("generates correct path for the Constitution", () => {
		const metadata = {
			id: "BOE-A-1978-31229",
			rank: "constitucion",
		} as NormMetadata;

		expect(normToFilepath(metadata)).toBe("constituciones/BOE-A-1978-31229.md");
	});
});
