import { describe, expect, test } from "bun:test";
import { classifyBillType } from "./parser.ts";

describe("classifyBillType", () => {
	test("Artículo único with 0 modifications = new_law (BOCG-15-B-15-1 pattern)", () => {
		// Simulates a bill with "Artículo único" and substantial body but no modification groups
		const text = `Exposición de motivos

Blah blah blah exposición de motivos text that is long enough.

Artículo único. Derogación del trasvase Tajo-Segura.

Se deroga el apartado primero del artículo 23 de la Ley 10/2001, de 5 de julio, del Plan Hidrológico Nacional, y cuantas disposiciones de rango legal o reglamentario regulen el trasvase Tajo-Segura.

${"Lorem ipsum dolor sit amet. ".repeat(80)}

Disposición derogatoria única. Derogación normativa.

Quedan derogadas cuantas disposiciones se opongan a lo establecido en la presente Ley.

Disposición final primera. Entrada en vigor.

La presente Ley entrará en vigor el día siguiente al de su publicación.`;

		const result = classifyBillType(text, []);
		expect(result).toBe("new_law");
	});

	test("Artículo único with modifications = amendment", () => {
		const text = `Artículo único. Modificación de la Ley Orgánica 10/1995, de 23 de noviembre, del Código Penal.

Se modifican los artículos 1 a 50 del Código Penal.

${"Lorem ipsum dolor sit amet. ".repeat(80)}

Disposición final primera. Entrada en vigor.`;

		const result = classifyBillType(text, [
			{
				title: "Modificación del Código Penal",
				targetLaw: "Ley Orgánica 10/1995, del Código Penal",
				modifications: [{ type: "modify", target: "artículo 1", content: "..." }],
			},
		]);
		expect(result).toBe("amendment");
	});

	test("multiple numbered articles with 0 modifications = new_law", () => {
		const text = `Exposición de motivos

Blah blah blah.

Artículo 1. Objeto.

Esta ley tiene por objeto regular...

Artículo 2. Ámbito de aplicación.

Esta ley se aplica a...

Artículo 3. Definiciones.

A los efectos de esta ley se entenderá por...

Disposición final primera. Entrada en vigor.`;

		const result = classifyBillType(text, []);
		expect(result).toBe("new_law");
	});
});
