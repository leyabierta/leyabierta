import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectReformEntries } from "../pipeline.ts";
import { parseDiarioXml } from "../transform/diario-xml-parser.ts";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function loadFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURES_DIR, name)));
}

describe("parseDiarioXml", () => {
	const xml = loadFixture("diario-BOE-A-2026-16010.xml");
	const norm = parseDiarioXml(xml);

	test("parses metadata", () => {
		expect(norm.metadata.id).toBe("BOE-A-2026-16010");
		expect(norm.metadata.rank).toBe("real_decreto");
		expect(norm.metadata.country).toBe("es");
		expect(norm.metadata.publishedAt).toBe("2026-07-23");
		expect(norm.metadata.department).toBe("Ministerio de Industria y Turismo");
		expect(norm.metadata.title).toContain("Real Decreto 609/2026");
		expect(norm.metadata.shortTitle).toBe("Real Decreto 609/2026");
	});

	test("marks the norm as diario-origin, not consolidated", () => {
		expect(norm.metadata.origin).toBe("diario");
		expect(norm.metadata.consolidated).toBe(false);
		expect(norm.metadata.section).toBe("1");
	});

	test("segments text into preambulo + 23 articulo blocks + firma + 5 anexos", () => {
		const preambulo = norm.blocks.filter((b) => b.type === "preambulo");
		const preceptos = norm.blocks.filter((b) => b.type === "precepto");
		const firma = norm.blocks.filter((b) => b.type === "firma");
		const anexos = norm.blocks.filter((b) => b.type === "anexo");

		expect(preambulo).toHaveLength(1);
		expect(preceptos).toHaveLength(23);
		expect(firma).toHaveLength(1);
		expect(anexos).toHaveLength(5);
	});

	test("precepto block ids are sequential a1..a23", () => {
		const preceptos = norm.blocks.filter((b) => b.type === "precepto");
		const ids = preceptos.map((b) => b.id);
		expect(ids).toEqual(Array.from({ length: 23 }, (_, i) => `a${i + 1}`));
	});

	test("precepto title comes from the p.articulo text", () => {
		const a1 = norm.blocks.find((b) => b.id === "a1");
		expect(a1?.title).toBe("Artículo 1. Objeto y líneas de financiación.");
	});

	test("each block has exactly one version dated at fecha_publicacion", () => {
		for (const block of norm.blocks) {
			expect(block.versions).toHaveLength(1);
			expect(block.versions[0]!.publishedAt).toBe("2026-07-23");
			expect(block.versions[0]!.effectiveAt).toBe("2026-07-23");
			expect(block.versions[0]!.normId).toBe("BOE-A-2026-16010");
		}
	});

	test("preambulo content precedes the first articulo", () => {
		const preambulo = norm.blocks.find((b) => b.type === "preambulo")!;
		expect(preambulo.versions[0]!.paragraphs.length).toBeGreaterThan(0);
	});

	test("synthesizes a single bootstrap reform covering every block", () => {
		expect(norm.reforms).toHaveLength(1);
		const reform = norm.reforms[0]!;
		expect(reform.date).toBe("2026-07-23");
		expect(reform.normId).toBe("BOE-A-2026-16010");
		expect(reform.affectedBlockIds).toHaveLength(norm.blocks.length);
		expect(new Set(reform.affectedBlockIds)).toEqual(
			new Set(norm.blocks.map((b) => b.id)),
		);
	});

	test("feeds collectReformEntries() so commitNormsChronologically would not skip it", () => {
		// Regression guard for the empty-reforms bug: a diario Norm with
		// `reforms: []` would silently produce zero commits downstream.
		const entries = collectReformEntries([norm]);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0]!.norm.metadata.id).toBe("BOE-A-2026-16010");
	});

	test("materias include the analisis materias and the alertas", () => {
		expect(norm.analisis?.materias).toEqual(
			expect.arrayContaining([
				"Ayudas",
				"Electricidad",
				"Ministerio de Industria y Turismo",
				"Subvenciones",
				"Vehículos de motor",
				"Transportes y tráfico", // from <alertas>, not <materias>
			]),
		);
	});

	test("notas are parsed", () => {
		expect(norm.analisis?.notas).toEqual([
			"Vigencia hasta el 31 de diciembre de 2030.",
		]);
	});

	test("referencias anteriores use <palabra> as the relation, not <relacion><texto>", () => {
		const refs = norm.analisis?.referencias.anteriores ?? [];
		expect(refs).toHaveLength(2);

		const conformidad = refs.find((r) => r.normId === "BOE-A-2026-6544");
		expect(conformidad?.relation).toBe("DE CONFORMIDAD con");
		expect(conformidad?.text).toBe(
			"el art. 34 del Real Decreto-ley 7/2026, de 20 de marzo",
		);

		const cita = refs.find((r) => r.normId === "DOUE-L-2019-80663");
		expect(cita?.relation).toBe("CITA");
	});
});

/** Minimal synthetic diario XML for testing edge cases the real fixture doesn't exercise. */
function buildDiarioXml(opts: {
	includeEli: boolean;
	texto: string;
}): Uint8Array {
	const eliBlock = opts.includeEli
		? "<url_eli>https://www.boe.es/eli/es/rd/2026/07/22/609</url_eli>"
		: "<url_eli/>";

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<documento fecha_actualizacion="20260723115602">
  <metadatos>
    <identificador>BOE-A-2026-99999</identificador>
    <origen_legislativo codigo="1">Estatal</origen_legislativo>
    <departamento codigo="9591">Ministerio de Ejemplo</departamento>
    <rango codigo="1340">Real Decreto</rango>
    <fecha_disposicion>20260722</fecha_disposicion>
    <titulo>Real Decreto de ejemplo.</titulo>
    <fecha_publicacion>20260723</fecha_publicacion>
    <seccion>1</seccion>
    <estatus_derogacion>N</estatus_derogacion>
    ${eliBlock}
  </metadatos>
  <analisis>
    <materias/>
    <notas/>
    <referencias><anteriores/><posteriores/></referencias>
  </analisis>
  <texto>
    ${opts.texto}
  </texto>
</documento>`;

	return new TextEncoder().encode(xml);
}

describe("parseDiarioXml — jurisdiction fallback", () => {
	test("resolves to 'es' when there is no <url_eli>, never undefined", () => {
		const xml = buildDiarioXml({
			includeEli: false,
			texto: `<p class="articulo">Artículo 1. Ejemplo.</p><p class="parrafo">Texto.</p>`,
		});
		const norm = parseDiarioXml(xml);
		expect(norm.metadata.country).toBe("es");
	});
});

describe("parseDiarioXml — anexo segmentation", () => {
	test("p.anexo_tit with no preceding p.anexo_num still opens an anexo block", () => {
		const xml = buildDiarioXml({
			includeEli: true,
			texto: [
				`<p class="articulo">Artículo 1. Ejemplo.</p>`,
				`<p class="parrafo">Texto del artículo.</p>`,
				// anexo_tit leads, no anexo_num before it
				`<p class="anexo_tit">Definiciones</p>`,
				`<p class="parrafo">Contenido del anexo.</p>`,
			].join("\n"),
		});
		const norm = parseDiarioXml(xml);

		const anexos = norm.blocks.filter((b) => b.type === "anexo");
		expect(anexos).toHaveLength(1);
		expect(anexos[0]!.title).toBe("Definiciones");
		expect(anexos[0]!.versions[0]!.paragraphs).toEqual([
			{ cssClass: "parrafo", text: "Contenido del anexo." },
		]);

		// The anexo content must not have leaked into the preceding precepto.
		const a1 = norm.blocks.find((b) => b.id === "a1")!;
		expect(a1.versions[0]!.paragraphs).toEqual([
			{ cssClass: "parrafo", text: "Texto del artículo." },
		]);
	});
});
