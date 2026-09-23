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
	});

	test("success is null", () => {
		expect(resendErrorOf({ data: { id: "x" }, error: null })).toBeNull();
		expect(resendErrorOf(undefined)).toBeNull();
	});
});
