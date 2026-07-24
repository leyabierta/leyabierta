import { describe, expect, test } from "bun:test";
import {
	type BoeLawData,
	compareSections,
	dedupeLaws,
	getBoeDates,
	groupBoeDay,
	sectionLabel,
} from "../boe-day.ts";

// Realistic default: /boe pages only ever surface diario (not-yet-
// consolidated) norms — see getBoeDates/groupBoeDay doc comments.
function law(
	overrides: Partial<BoeLawData> & { identificador: string },
): BoeLawData {
	return {
		titulo: "Norma de prueba",
		rango: "ley",
		departamento: "Ministerio de Prueba",
		jurisdiccion: "es",
		fecha_publicacion: "2026-07-23",
		consolidado: false,
		seccion: "1",
		...overrides,
	};
}

describe("sectionLabel", () => {
	test("maps known codes to plain-language labels", () => {
		expect(sectionLabel("1")).toBe("Disposiciones generales");
	});

	test("falls back gracefully for unknown codes", () => {
		expect(sectionLabel("9Z")).toBe("Sección 9Z");
	});

	test("falls back for an empty code", () => {
		expect(sectionLabel("")).toBe("Otras publicaciones");
	});
});

describe("compareSections", () => {
	test("orders in true BOE sumario order: numeric prefix first, then letter suffix", () => {
		const sections = ["3", "5B", "2B", "1", "2A", "5A", "5C"];
		expect([...sections].sort(compareSections)).toEqual([
			"1",
			"2A",
			"2B",
			"3",
			"5A",
			"5B",
			"5C",
		]);
	});
});

describe("dedupeLaws", () => {
	test("keeps the first occurrence of a repeated id", () => {
		const laws = [
			law({ identificador: "A", titulo: "Primera" }),
			law({ identificador: "A", titulo: "Duplicada" }),
			law({ identificador: "B" }),
		];
		const out = dedupeLaws(laws);
		expect(out).toHaveLength(2);
		expect(out[0]?.titulo).toBe("Primera");
	});
});

describe("getBoeDates", () => {
	test("returns distinct diario dates, newest first", () => {
		const laws = [
			law({ identificador: "A", fecha_publicacion: "2026-07-20" }),
			law({ identificador: "B", fecha_publicacion: "2026-07-23" }),
			law({ identificador: "C", fecha_publicacion: "2026-07-20" }),
		];
		expect(getBoeDates(laws)).toEqual(["2026-07-23", "2026-07-20"]);
	});

	test("ignores already-consolidated norms — /boe mirrors the diario, not the full archive", () => {
		const laws = [
			law({
				identificador: "OLD",
				consolidado: true,
				fecha_publicacion: "1978-12-29",
			}),
			law({ identificador: "NEW", fecha_publicacion: "2026-07-23" }),
		];
		expect(getBoeDates(laws)).toEqual(["2026-07-23"]);
	});
});

describe("groupBoeDay", () => {
	test("filters to the given date and groups by section in natural order", () => {
		const laws = [
			law({ identificador: "A", seccion: "1", titulo: "Zeta" }),
			law({ identificador: "B", seccion: "2A", titulo: "Alfa" }),
			law({ identificador: "C", seccion: "1", titulo: "Alfa" }),
			// Different day — must not leak in.
			law({
				identificador: "D",
				seccion: "1",
				fecha_publicacion: "2026-07-22",
			}),
		];
		const grouped = groupBoeDay(laws, "2026-07-23");
		expect(grouped.map((s) => s.section)).toEqual(["1", "2A"]);
		expect(grouped[0]?.label).toBe("Disposiciones generales");
		// Within a section, sorted by title.
		expect(grouped[0]?.items.map((i) => i.id)).toEqual(["C", "A"]);
	});

	test("returns an empty array for a day with no publications", () => {
		expect(groupBoeDay([], "2026-07-23")).toEqual([]);
	});

	test("excludes norms that have already been consolidated, even if published that day", () => {
		const laws = [
			law({ identificador: "A", consolidado: false }),
			law({ identificador: "B", consolidado: true }),
		];
		const grouped = groupBoeDay(laws, "2026-07-23");
		const ids = grouped.flatMap((s) => s.items.map((i) => i.id));
		expect(ids).toEqual(["A"]);
		expect(grouped[0]?.items[0]?.consolidado).toBe(false);
	});
});
