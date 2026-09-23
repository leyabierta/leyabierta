import { describe, expect, test } from "bun:test";
import { computeMaterias } from "../data/materia-mappings.ts";
import { resolveSubscribeMaterias } from "../routes/alerts.ts";
import { resendErrorOf } from "../services/email.ts";

describe("resolveSubscribeMaterias", () => {
	// Exactly what /cambios/para-mi/ sends (answers from /mi-situacion).
	const answers = {
		workStatus: "cuenta_ajena",
		sector: null,
		housing: "alquilo",
		family: ["hijos_menores"],
		extras: ["coche"],
	};

	test("resolves the web's answers like /v1/reforms/personal", () => {
		const materias = resolveSubscribeMaterias({ answers });
		expect(materias).toContain("Arrendamientos urbanos");
		expect(materias).toContain("Menores");
		expect(materias).toEqual(computeMaterias({ ...answers }));
	});

	test("explicit materias win", () => {
		expect(
			resolveSubscribeMaterias({ materias: ["Vivienda"], answers }),
		).toEqual(["Vivienda"]);
	});

	test("missing optional answers get the /v1/reforms/personal defaults", () => {
		expect(
			resolveSubscribeMaterias({ answers: { workStatus: "jubilado" } }),
		).toEqual(
			computeMaterias({
				workStatus: "jubilado",
				sector: null,
				housing: "familiares",
				family: [],
				extras: [],
			}),
		);
	});

	test("a sector with hundreds of materias resolves all of them", () => {
		const materias = resolveSubscribeMaterias({
			answers: {
				workStatus: "cuenta_ajena",
				sector: "campo",
				housing: "alquilo",
			},
		});
		expect(materias.length).toBeGreaterThan(60);
	});

	test("prototype keys resolve to nothing instead of throwing", () => {
		for (const key of ["__proto__", "constructor", "toString"]) {
			expect(() =>
				resolveSubscribeMaterias({
					answers: {
						workStatus: key,
						sector: key,
						housing: key,
						family: [key],
						extras: [key],
					},
				}),
			).not.toThrow();
		}
	});

	test("nothing to resolve gives no topics", () => {
		expect(resolveSubscribeMaterias({})).toEqual([]);
		expect(resolveSubscribeMaterias({ answers: {} })).toEqual([]);
	});
});

describe("resendErrorOf", () => {
	test("the SDK's returned error is reported (it does not throw)", () => {
		expect(
			resendErrorOf({
				data: null,
				error: {
					name: "validation_error",
					message: "The leyabierta.es domain is not verified.",
				},
			}),
		).toBe("validation_error: The leyabierta.es domain is not verified.");
		expect(
			resendErrorOf({
				error: { name: "x", message: "Invalid `to`: ana.garcia@example.com" },
			}),
		).toBe("x: Invalid `to`: <email>");
	});

	test("success is null", () => {
		expect(resendErrorOf({ data: { id: "x" }, error: null })).toBeNull();
		expect(resendErrorOf(undefined)).toBeNull();
	});
});
