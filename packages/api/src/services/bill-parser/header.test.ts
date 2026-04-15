import { describe, expect, test } from "bun:test";
import { extractTitle } from "./header.ts";

describe("extractTitle", () => {
	test("extracts title from PROYECTO DE LEY", () => {
		const text = `PROYECTO DE LEY
121/000042 Proyecto de Ley Orgánica de medidas en materia de eficiencia del Servicio Público de Justicia.
La Mesa del Congreso`;
		expect(extractTitle(text)).not.toBe("unknown");
	});

	test("extracts title from PROPOSICIÓN DE LEY", () => {
		const text = `PROPOSICIÓN DE LEY
122/000001 Proposición de Ley de modificación del Código Penal.
La Mesa del Congreso`;
		expect(extractTitle(text)).not.toBe("unknown");
	});

	test("extracts title from PROPOSICIÓN DE REFORMA DEL REGLAMENTO (BOCG-15-B-30-1)", () => {
		const text = `PROPOSICIÓN DE REFORMA DEL REGLAMENTO
DEL CONGRESO
410/000003 Proposición de reforma del Reglamento del Congreso de los Diputados, de 10 de febrero de 1982.
Presentada por el Grupo Parlamentario`;
		const title = extractTitle(text);
		expect(title).not.toBe("unknown");
		expect(title).toContain("Reglamento del Congreso");
	});

	test("extracts title from PROPOSICIÓN DE REFORMA CONSTITUCIONAL (BOCG-15-B-5-1)", () => {
		const text = `PROPOSICIÓN DE REFORMA CONSTITUCIONAL
101/000001 Proposición de reforma de los artículos 87.3, 92 y 166 de la Constitución.
La Mesa del Congreso`;
		const title = extractTitle(text);
		expect(title).not.toBe("unknown");
		expect(title).toContain("Constitución");
	});
});
