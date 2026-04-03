import { describe, expect, test } from "bun:test";
import {
	BASE_MATERIAS,
	computeMaterias,
	EXTRAS_MATERIAS,
	FAMILY_MATERIAS,
	HOUSING_MATERIAS,
	type OnboardingAnswers,
	SECTOR_MATERIAS,
	SKIP_SECTOR_STATUSES,
	WORK_STATUS_MATERIAS,
} from "../data/materia-mappings.ts";

function makeAnswers(
	overrides: Partial<OnboardingAnswers> = {},
): OnboardingAnswers {
	return {
		workStatus: "cuenta_ajena",
		sector: null,
		housing: "alquilo",
		family: [],
		extras: [],
		...overrides,
	};
}

describe("computeMaterias", () => {
	test("base materias are always present regardless of answers", () => {
		const result = computeMaterias(
			makeAnswers({
				workStatus: "no_trabajo",
				housing: "familiares",
			}),
		);
		for (const m of BASE_MATERIAS) {
			expect(result).toContain(m);
		}
	});

	test("work status autonomo adds the right materias", () => {
		const result = computeMaterias(makeAnswers({ workStatus: "autonomo" }));
		for (const m of WORK_STATUS_MATERIAS.autonomo) {
			expect(result).toContain(m);
		}
	});

	test("sector is skipped when null", () => {
		const withSector = computeMaterias(makeAnswers({ sector: "sanidad" }));
		const withoutSector = computeMaterias(makeAnswers({ sector: null }));

		// Sanidad materias should only be in the with-sector result
		for (const m of SECTOR_MATERIAS.sanidad) {
			expect(withSector).toContain(m);
		}
		// At least one sanidad-specific materia should be absent without sector
		const sanidadOnly = SECTOR_MATERIAS.sanidad.filter(
			(m) => !BASE_MATERIAS.includes(m),
		);
		expect(sanidadOnly.some((m) => !withoutSector.includes(m))).toBe(true);
	});

	test("family multi-select accumulates materias", () => {
		const result = computeMaterias(
			makeAnswers({ family: ["hijos_menores", "dependiente"] }),
		);
		for (const m of FAMILY_MATERIAS.hijos_menores) {
			expect(result).toContain(m);
		}
		for (const m of FAMILY_MATERIAS.dependiente) {
			expect(result).toContain(m);
		}
	});

	test("extras multi-select accumulates materias", () => {
		const result = computeMaterias(
			makeAnswers({ extras: ["coche", "mascotas"] }),
		);
		for (const m of EXTRAS_MATERIAS.coche) {
			expect(result).toContain(m);
		}
		for (const m of EXTRAS_MATERIAS.mascotas) {
			expect(result).toContain(m);
		}
	});

	test("no duplicates when same materia appears in multiple answers", () => {
		// "Familia" appears in both dependiente and embarazo_baja
		const result = computeMaterias(
			makeAnswers({ family: ["dependiente", "embarazo_baja"] }),
		);
		const familiaCount = result.filter((m) => m === "Familia").length;
		expect(familiaCount).toBe(1);
	});

	test("unknown answer keys return only base materias (plus housing)", () => {
		const result = computeMaterias(
			makeAnswers({
				workStatus: "unknown_status",
				housing: "familiares",
				family: ["unknown_family"],
				extras: ["unknown_extra"],
			}),
		);
		// Should only have base materias
		expect(result.length).toBe(BASE_MATERIAS.length);
		for (const m of BASE_MATERIAS) {
			expect(result).toContain(m);
		}
	});

	test("SKIP_SECTOR_STATUSES contains the right values", () => {
		expect(SKIP_SECTOR_STATUSES).toContain("jubilado");
		expect(SKIP_SECTOR_STATUSES).toContain("estudiante");
		expect(SKIP_SECTOR_STATUSES).toContain("no_trabajo");
		expect(SKIP_SECTOR_STATUSES).toHaveLength(3);
	});

	test("housing materias are included", () => {
		const result = computeMaterias(makeAnswers({ housing: "hipoteca" }));
		for (const m of HOUSING_MATERIAS.hipoteca) {
			expect(result).toContain(m);
		}
	});
});
