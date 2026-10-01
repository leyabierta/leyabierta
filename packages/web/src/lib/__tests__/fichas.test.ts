import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	FICHA_DESCRIPTION_MAX,
	type FichaSection,
	fichaContentParts,
	fichaSeoTitle,
	hasFicha,
	laterDate,
	loadFichas,
	markReferences,
	noticesFor,
	otherChanges,
	parseFicha,
	parseFichas,
	parseSections,
	renderFichaBody,
	setFichasForTesting,
} from "../fichas.ts";
import { codePointLength } from "../meta-description.ts";
import { type LastmodManifestInput, lawContentHash } from "../page-lastmod.ts";
import { SEO_TITLE_MAX } from "../seo-title.ts";

const FRONT = `---
identificador: "BOE-A-2026-1"
nombre_corto: "Real Decreto-ley 1/2026"
etiquetas: ["Real decreto-ley", "Vivienda"]
titular: "Un titular claro"
subtitulo: "Real Decreto-ley 1/2026, de 1 de enero"
estado: ["En vigor desde el 2 de enero"]
seo_titulo: "Un titular claro (RDL 1/2026)"
descripcion: "Una descripción suficientemente larga para pasar la validación."
revisado: "2026-01-03"
en_vigor: "2026-01-02"
modifica:
  - identificador: "BOE-A-1994-26003"
    articulos: ["10"]
---
`;

const BODY = `## En 30 segundos

- **Primera idea.** Primera idea. [art. 10.1 LAU]
- Segunda idea. [DT, ap. 2]

## Qué cambia

|  | Antes | Ahora |
| --- | --- | --- |
| Aviso | 4 meses | 6 meses |

Fuente: artículo 10.

## Qué significa para ti

### Si vives de alquiler

- Te toca algo. [10.1]

### Si alquilas tu vivienda

- Caso general: [10.2]
  - Excepción a.
  - Excepción b.
- Tampoco pagas. [10.1]

## Desde cuándo y a qué contratos

- **Contratos ya firmados.** Se aplica también. [DT, ap. 1]
- **Una duda.** {.duda} El texto deja la cuestión abierta. [DA 1.ª]

## Estado

Ya se aplica.

A 1 de enero, el BOE ya lo incluye.

## Qué no hace

No cambia la renta. [exposición de motivos]

## Nota

Resumen en lenguaje sencillo.

Fuente: BOE · [BOE-A-2026-1](https://www.boe.es/buscar/doc.php?id=BOE-A-2026-1)
`;

const SOURCE = FRONT + BODY;

afterEach(() => setFichasForTesting(undefined));

describe("parseFicha", () => {
	test("parses frontmatter and keeps dates as strings", () => {
		const f = parseFicha(SOURCE, "BOE-A-2026-1.md");
		expect(f.identificador).toBe("BOE-A-2026-1");
		expect(f.revisado).toBe("2026-01-03");
		expect(f.modifica[0]!.articulos).toEqual(["10"]);
		expect(f.body.startsWith("## En 30 segundos")).toBe(true);
	});

	test("a plain estado string is a blue (hecho) badge; tones are validated", () => {
		const f = parseFicha(SOURCE, "x.md");
		expect(f.estado).toEqual([
			{ texto: "En vigor desde el 2 de enero", tono: "hecho" },
		]);
		const toned = parseFicha(
			SOURCE.replace(
				'estado: ["En vigor desde el 2 de enero"]',
				'estado:\n  - texto: "Pendiente"\n    tono: "pendiente"',
			),
			"x.md",
		);
		expect(toned.estado).toEqual([{ texto: "Pendiente", tono: "pendiente" }]);
		expect(() =>
			parseFicha(
				SOURCE.replace(
					'estado: ["En vigor desde el 2 de enero"]',
					'estado:\n  - texto: "X"\n    tono: "rojo"',
				),
				"x.md",
			),
		).toThrow(/tono/);
	});

	test("cifras and hitos are optional and validated", () => {
		const f = parseFicha(SOURCE, "x.md");
		expect(f.cifras).toEqual([]);
		expect(f.hitos).toEqual([]);
		const withData = parseFicha(
			SOURCE.replace(
				'en_vigor: "2026-01-02"',
				`en_vigor: "2026-01-02"
cifras:
  - valor: "5 años"
    texto: "cada prórroga"
hitos:
  - fecha: "2 ene 2026"
    titulo: "En vigor"
    texto: "Se aplica."
    estado: "vigente"
    ref: "DF 2.ª"`,
			),
			"x.md",
		);
		expect(withData.cifras).toEqual([
			{ valor: "5 años", texto: "cada prórroga" },
		]);
		expect(withData.hitos[0]).toEqual({
			fecha: "2 ene 2026",
			titulo: "En vigor",
			texto: "Se aplica.",
			estado: "vigente",
			ref: "DF 2.ª",
		});
		expect(() =>
			parseFicha(
				SOURCE.replace(
					'en_vigor: "2026-01-02"',
					'en_vigor: "2026-01-02"\nhitos:\n  - fecha: "x"\n    titulo: "y"\n    texto: "z"\n    estado: "luego"',
				),
				"x.md",
			),
		).toThrow(/estado/);
	});

	test("hitos need a «Desde cuándo» section to be shown in", () => {
		const src = SOURCE.replace(
			'en_vigor: "2026-01-02"',
			'en_vigor: "2026-01-02"\nhitos:\n  - fecha: "x"\n    titulo: "y"\n    texto: "z"\n    estado: "hecho"',
		).replace(/## Desde cuándo[\s\S]*?(?=## Estado)/, "");
		expect(() => parseFicha(src, "x.md")).toThrow(/hitos/);
	});

	test("fails loudly on a missing frontmatter or an invalid field", () => {
		expect(() => parseFicha(BODY, "x.md")).toThrow(/frontmatter/);
		expect(() =>
			parseFicha(
				SOURCE.replace('revisado: "2026-01-03"', 'revisado: "ayer"'),
				"x.md",
			),
		).toThrow(/revisado/);
		const long = "a".repeat(FICHA_DESCRIPTION_MAX + 1);
		expect(() =>
			parseFicha(
				SOURCE.replace(/descripcion: ".*"/, `descripcion: "${long}"`),
				"x.md",
			),
		).toThrow(/descripcion/);
	});

	test("rejects a file whose name does not match its id", () => {
		expect(() => parseFichas({ "BOE-A-2026-2.md": SOURCE })).toThrow(
			/no coincide/,
		);
	});
});

describe("parseSections", () => {
	const sections = parseSections(BODY);
	const byKind = <K extends FichaSection["kind"]>(kind: K) =>
		sections.find((s) => s.kind === kind) as FichaSection & { kind: K };

	test("one section per known «##», in file order, with anchors and index", () => {
		expect(sections.map((s) => [s.kind, s.id, s.tocLabel])).toEqual([
			["summary", "ficha-resumen", "En 30 segundos"],
			["changes", "ficha-cambios", "Qué cambia"],
			["audiences", "ficha-para-ti", "Qué significa para ti"],
			["dates", "ficha-fechas", "Desde cuándo"],
			["status", "ficha-estado", "Estado"],
			["limits", "ficha-no-hace", null],
			["note", "ficha-nota", null],
		]);
		// The law page already has #resumen: every anchor is prefixed.
		expect(sections.every((s) => s.id.startsWith("ficha-"))).toBe(true);
		expect(byKind("changes").kicker).toBe("Antes y ahora");
	});

	test("a leading bold sentence is the card title; the rest stays as written", () => {
		const [first, second] = byKind("summary").items;
		expect(first!.title).toBe("Primera idea");
		expect(first!.html).toBe(
			'Primera idea. <span class="ficha-ref">art. 10.1 LAU</span>',
		);
		expect(second!.title).toBeUndefined();
		expect(second!.html).toBe(
			'Segunda idea. <span class="ficha-ref">DT, ap. 2</span>',
		);
	});

	test("{.duda} marks an open question and is removed from the text", () => {
		const [signed, doubt] = byKind("dates").items;
		expect(signed!.flags).toEqual([]);
		expect(doubt!.title).toBe("Una duda");
		expect(doubt!.flags).toEqual(["duda"]);
		expect(doubt!.html).toStartWith("El texto deja la cuestión abierta.");
		expect(() => parseSections(BODY.replace("{.duda}", "{.urgente}"))).toThrow(
			/marca desconocida \{\.urgente\}/,
		);
	});

	test("the comparison table: columns, row topics, cells and source notes", () => {
		const c = byKind("changes");
		expect(c.corner).toBe("Situación");
		expect(c.columns).toEqual(["Antes", "Ahora"]);
		expect(c.rows).toEqual([{ topic: "Aviso", cells: ["4 meses", "6 meses"] }]);
		expect(c.notes).toEqual(["Fuente: artículo 10."]);
	});

	test("audiences: one group per «###», with icon and sublists", () => {
		const { groups } = byKind("audiences");
		expect(groups.map((g) => [g.title, g.icon])).toEqual([
			["Si vives de alquiler", "casa"],
			["Si alquilas tu vivienda", "llave"],
		]);
		const [general, tampoco] = groups[1]!.items;
		expect(general!.html).toBe(
			'Caso general: <span class="ficha-ref">10.2</span>',
		);
		expect(general!.subitems).toEqual(["Excepción a.", "Excepción b."]);
		expect(tampoco!.subitems).toEqual([]);
	});

	test("status, limits and note keep their paragraphs (and links)", () => {
		expect(byKind("status").paragraphs).toEqual([
			"Ya se aplica.",
			"A 1 de enero, el BOE ya lo incluye.",
		]);
		expect(byKind("note").paragraphs[1]).toBe(
			'Fuente: BOE · <a href="https://www.boe.es/buscar/doc.php?id=BOE-A-2026-1">BOE-A-2026-1</a>',
		);
	});

	test("an unknown «##» is kept as plain Markdown", () => {
		const [s] = parseSections(
			"## Otra cosa\n\nTexto [art. 1].\n\n### Detalle\n\n- a",
		);
		expect(s!.kind).toBe("prose");
		expect(s!.id).toBe("ficha-otra-cosa");
		expect(s!.tocLabel).toBe("Otra cosa");
		const html = (s as Extract<FichaSection, { kind: "prose" }>).html;
		expect(html).toContain('<span class="ficha-ref">art. 1</span>');
		expect(html).toContain('<h4 class="ficha-heading">Detalle</h4>');
	});

	test("«Otros cambios»: one list, references marked, out of the index", () => {
		const withOthers = `${BODY}
## Otros cambios

- **Registro.** Se crea un registro de contratos. [DA 2.ª]
- Cambia una remisión técnica. [art. 4] [DF 1.ª]
  - En el apartado 2.
`;
		const all = parseSections(withOthers);
		const others = all[all.length - 1] as FichaSection & { kind: "others" };
		expect([others.kind, others.id, others.tocLabel, others.kicker]).toEqual([
			"others",
			"ficha-otros-cambios",
			null,
			null,
		]);
		expect(others.title).toBe("Otros cambios");
		expect(others.items.map((i) => [i.title, i.html, i.subitems])).toEqual([
			[
				"Registro",
				'Se crea un registro de contratos. <span class="ficha-ref">DA 2.ª</span>',
				[],
			],
			[
				undefined,
				'Cambia una remisión técnica. <span class="ficha-ref">art. 4 · DF 1.ª</span>',
				["En el apartado 2."],
			],
		]);
		// The rest of the ficha is parsed as before.
		expect(all.slice(0, -1)).toEqual(sections);
		expect(otherChanges({ sections: all })).toBe(others);
		expect(() => parseSections("## Otros cambios\n\nUn párrafo.")).toThrow(
			/lista/,
		);
	});

	test("without «Otros cambios» nothing changes", () => {
		expect(sections.some((s) => s.kind === "others")).toBe(false);
		expect(otherChanges({ sections })).toBeUndefined();
		const f = parseFicha(SOURCE, "x.md");
		expect(f.sections).toEqual(sections);
		expect(otherChanges(f)).toBeUndefined();
	});

	test("a ficha with only some sections works", () => {
		const s = parseSections("## Estado\n\nEn vigor.");
		expect(s.map((x) => x.kind)).toEqual(["status"]);
	});

	test("fails loudly on structures the layout cannot show", () => {
		expect(() => parseSections("Texto suelto.\n\n## Estado\n\nX.")).toThrow(
			/antes del primer/,
		);
		expect(() => parseSections("## Estado\n\nX.\n\n## Estado\n\nY.")).toThrow(
			/repetida/,
		);
		expect(() => parseSections("## En 30 segundos\n\nUn párrafo.")).toThrow(
			/lista/,
		);
		expect(() => parseSections("## Qué cambia\n\n- una lista")).toThrow(
			/tabla/,
		);
		expect(() =>
			parseSections("## Qué significa para ti\n\n- sin grupo"),
		).toThrow(/###/);
		expect(() => parseSections("## Estado\n\n- una lista")).toThrow(/párrafos/);
	});
});

describe("renderFichaBody (unknown sections)", () => {
	const html = renderFichaBody(
		"## Comparación\n\n|  | Antes | Ahora |\n| --- | --- | --- |\n| Aviso | 4 meses | 6 meses |\n\nFuente: artículo 10.\n\n- Caso general: [10.2]\n  - Excepción a.",
	);

	test("shifts headings one level down (the titular is the h2)", () => {
		expect(html).toContain('<h3 class="ficha-heading">Comparación</h3>');
		expect(html).not.toContain("<h2");
	});

	test("makes an accessible table: caption, column and row headers, labels", () => {
		expect(html).toContain('<caption class="sr-only">Comparación</caption>');
		expect(html).toContain(
			'<th scope="col"><span class="sr-only">Situación</span></th>',
		);
		expect(html).toContain('<th scope="row">Aviso</th>');
		expect(html).toContain('<td data-label="Ahora">6 meses</td>');
	});

	test("source notes, nested lists and references", () => {
		expect(html).toContain('<p class="ficha-source">Fuente: artículo 10.</p>');
		expect(html).toMatch(/Caso general:.*<ul>\s*<li>Excepción a\.<\/li>/s);
		expect(html).toContain('<span class="ficha-ref">10.2</span>');
	});
});

describe("markReferences", () => {
	test("drops the brackets and joins references that follow each other", () => {
		expect(markReferences("Texto. [10.1] [art. 11 LAU]")).toBe(
			'Texto. <span class="ficha-ref">10.1 · art. 11 LAU</span>',
		);
	});

	test("leaves real links alone", () => {
		expect(markReferences('<a href="https://x">BOE</a>')).toBe(
			'<a href="https://x">BOE</a>',
		);
	});
});

describe("SEO helpers", () => {
	test("title stays within the limit, with the site suffix", () => {
		const t = fichaSeoTitle({ seo_titulo: "Un titular claro (RDL 1/2026)" });
		expect(t).toBe("Un titular claro (RDL 1/2026) — Ley Abierta");
		const long = fichaSeoTitle({ seo_titulo: "palabra ".repeat(20).trim() });
		expect(codePointLength(long)).toBeLessThanOrEqual(SEO_TITLE_MAX);
	});

	test("laterDate", () => {
		expect(laterDate("2026-01-01", "2026-10-01")).toBe("2026-10-01");
		expect(laterDate(undefined, "2026-10-01")).toBe("2026-10-01");
		expect(laterDate("2026-01-01", undefined)).toBe("2026-01-01");
	});
});

describe("notices", () => {
	test("derived from `modifica`, only on the modified law", () => {
		const fichas = parseFichas({ "BOE-A-2026-1.md": SOURCE });
		const [n, ...rest] = noticesFor("BOE-A-1994-26003", fichas);
		expect(rest).toHaveLength(0);
		expect(n!.text).toBe(
			"El artículo 10 de esta ley ha sido modificado por el Real Decreto-ley 1/2026 (en vigor desde el 2 de enero de 2026). Es posible que el texto del BOE y los resúmenes de esta página todavía no lo reflejen.",
		);
		expect(n!.href).toBe("/leyes/BOE-A-2026-1/");
		expect(noticesFor("BOE-A-2026-1", fichas)).toHaveLength(0);
		expect(noticesFor("BOE-A-1978-31229", fichas)).toHaveLength(0);
	});

	test("plural articles and a BOE text that already includes the change", () => {
		const src = SOURCE.replace(
			'articulos: ["10"]',
			'articulos: ["9", "10", "11"]\n    boe_consolidado: "2026-01-02"',
		);
		const [n] = noticesFor(
			"BOE-A-1994-26003",
			parseFichas({ "BOE-A-2026-1.md": src }),
		);
		expect(n!.text).toStartWith(
			"Los artículos 9, 10 y 11 de esta ley han sido modificados por",
		);
		expect(n!.text).toContain(
			"El texto consolidado del BOE ya incluye el cambio",
		);
	});
});

describe("lastmod parts", () => {
	const empty: LastmodManifestInput = {
		citizens: {},
		reforms: {},
		articles: {},
	};

	test("both the ficha's law and the modified law get own content", () => {
		const fichas = parseFichas({ "BOE-A-2026-1.md": SOURCE });
		const parts = fichaContentParts(fichas);
		expect(Object.keys(parts).sort()).toEqual([
			"BOE-A-1994-26003",
			"BOE-A-2026-1",
		]);
		const m = { ...empty, fichas: parts };
		expect(lawContentHash("BOE-A-2026-1", m)).toBeDefined();
		expect(lawContentHash("BOE-A-1994-26003", m)).toBeDefined();
	});

	test("a law without fichas keeps its previous hash", () => {
		const m: LastmodManifestInput = {
			...empty,
			citizens: { "BOE-A-9": { summary: "Resumen", tags: [] } },
		};
		const before = lawContentHash("BOE-A-9", m);
		const parts = fichaContentParts(parseFichas({ "BOE-A-2026-1.md": SOURCE }));
		expect(lawContentHash("BOE-A-9", { ...m, fichas: parts })).toBe(before!);
	});

	test("editing the ficha changes its hash", () => {
		const a = fichaContentParts(parseFichas({ "BOE-A-2026-1.md": SOURCE }));
		const b = fichaContentParts(
			parseFichas({
				"BOE-A-2026-1.md": SOURCE.replace("Primera idea.", "Otra idea."),
			}),
		);
		expect(lawContentHash("BOE-A-2026-1", { ...empty, fichas: a })).not.toBe(
			lawContentHash("BOE-A-2026-1", { ...empty, fichas: b })!,
		);
	});
});

describe("published fichas (src/data/fichas)", () => {
	const fichas = loadFichas();

	test("every file loads, with a title and description within limits", () => {
		expect(fichas.size).toBeGreaterThan(0);
		for (const f of fichas.values()) {
			expect(codePointLength(fichaSeoTitle(f))).toBeLessThanOrEqual(
				SEO_TITLE_MAX,
			);
			expect(codePointLength(f.descripcion)).toBeLessThanOrEqual(
				FICHA_DESCRIPTION_MAX,
			);
		}
	});

	test("RDL 27/2026: ficha on its page and notice on the LAU", () => {
		expect(hasFicha("BOE-A-2026-20385")).toBe(true);
		const [n] = noticesFor("BOE-A-1994-26003");
		expect(n!.text).toContain("El artículo 10 de esta ley ha sido modificado");
		expect(n!.text).toContain("Real Decreto-ley 27/2026");
		expect(n!.text).toContain("en vigor desde el 2 de octubre de 2026");
		expect(n!.href).toBe("/leyes/BOE-A-2026-20385/");
	});

	test("RDL 27/2026: every block of the design has its data", () => {
		const f = fichas.get("BOE-A-2026-20385")!;
		expect(f.cifras.map((c) => c.valor)).toEqual([
			"5 años",
			"6 meses",
			"12 meses",
		]);
		expect(f.hitos.map((h) => h.estado)).toEqual([
			"hecho",
			"hecho",
			"vigente",
			"pendiente",
		]);
		expect(f.estado.map((e) => e.tono)).toEqual([
			"hecho",
			"vigente",
			"pendiente",
		]);
		expect(f.sections.map((s) => s.kind)).toEqual([
			"summary",
			"changes",
			"audiences",
			"dates",
			"status",
			"limits",
			"note",
		]);
		const summary = f.sections.find((s) => s.kind === "summary");
		const dates = f.sections.find((s) => s.kind === "dates");
		if (summary?.kind !== "summary" || dates?.kind !== "dates")
			throw new Error();
		expect(summary.items.every((i) => i.title)).toBe(true);
		expect(dates.items.every((i) => i.title)).toBe(true);
		expect(dates.items.filter((i) => i.flags.includes("duda"))).toHaveLength(1);
	});

	test("the internal reference-file note is not published", () => {
		const raw = readFileSync(
			resolve(import.meta.dir, "../../data/fichas/BOE-A-2026-20385.md"),
			"utf-8",
		);
		expect(raw).not.toContain("(gold)");
		expect(raw).not.toContain("Te avisaremos");
	});
});
