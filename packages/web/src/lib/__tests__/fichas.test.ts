import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	FICHA_DESCRIPTION_MAX,
	fichaContentParts,
	fichaSeoTitle,
	hasFicha,
	laterDate,
	loadFichas,
	markReferences,
	noticesFor,
	parseFicha,
	parseFichas,
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

- Primera idea. [art. 10.1 LAU]
- Segunda idea. [DT, ap. 2]

## Qué cambia

|  | Antes | Ahora |
| --- | --- | --- |
| Aviso | 4 meses | 6 meses |

Fuente: artículo 10.

### Subsección

- Caso general: [10.2]
  - Excepción a.
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

describe("renderFichaBody", () => {
	const html = renderFichaBody(BODY);

	test("shifts headings one level down (the titular is the h2)", () => {
		expect(html).toContain('<h3 class="ficha-heading">En 30 segundos</h3>');
		expect(html).toContain('<h4 class="ficha-heading">Subsección</h4>');
		expect(html).not.toContain("<h2");
	});

	test("makes an accessible table: caption, column and row headers, labels", () => {
		expect(html).toContain('<caption class="sr-only">Qué cambia</caption>');
		expect(html).toContain(
			'<th scope="col"><span class="sr-only">Situación</span></th>',
		);
		expect(html).toContain('<th scope="col">Antes</th>');
		expect(html).toContain('<th scope="row">Aviso</th>');
		expect(html).toContain('<td data-label="Antes">4 meses</td>');
		expect(html).toContain('<td data-label="Ahora">6 meses</td>');
		expect(html).not.toMatch(/<\/td>\s*<\/th>|<th scope="row">[^<]*<\/td>/);
	});

	test("marks legal references as secondary text and source notes", () => {
		expect(html).toContain('<span class="ficha-ref">[art. 10.1 LAU]</span>');
		expect(html).toContain('<span class="ficha-ref">[DT, ap. 2]</span>');
		expect(html).toContain('<p class="ficha-source">Fuente: artículo 10.</p>');
	});

	test("keeps nested lists", () => {
		expect(html).toMatch(/Caso general:.*<ul>\s*<li>Excepción a\.<\/li>/s);
	});

	test("markReferences leaves real links alone", () => {
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

	test("the internal reference-file note is not published", () => {
		const raw = readFileSync(
			resolve(import.meta.dir, "../../data/fichas/BOE-A-2026-20385.md"),
			"utf-8",
		);
		expect(raw).not.toContain("(gold)");
		expect(raw).not.toContain("Te avisaremos");
	});
});
