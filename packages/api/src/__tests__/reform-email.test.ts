import { describe, expect, test } from "bun:test";
import {
	buildAiNotice,
	buildMultiReformHtml,
	buildSingleReformHtml,
	type ReformEmailItem,
} from "../services/reform-email.ts";

const SITE = "https://leyabierta.es";
const UNSUB = `${SITE}/alertas/cancelar?email=x&code=y`;

function reform(over: Partial<ReformEmailItem> = {}): ReformEmailItem {
	return {
		id: "BOE-A-2015-11430",
		title: "Estatuto de los Trabajadores",
		date: "2026-09-01",
		source_id: "BOE-A-2026-12345",
		headline: "Cambia el <permiso> por nacimiento",
		summary: "El permiso pasa a 20 semanas.",
		reform_type: "modification",
		importance: "high",
		...over,
	};
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("reform alert emails carry the AI notice", () => {
	test("single-reform email: notice + link to the disposition on the BOE", () => {
		const html = buildSingleReformHtml(SITE, reform(), UNSUB);
		expect(html).toContain(
			"Resumen generado con inteligencia artificial; puede contener errores.",
		);
		expect(html).toContain(
			'href="https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-12345"',
		);
		expect(html).toContain(`${SITE}/sobre/#resumenes-ia`);
		// Headline stays escaped.
		expect(html).toContain("Cambia el &lt;permiso&gt; por nacimiento");
		expect(html).not.toContain("<permiso>");
	});

	test("multi-reform email: one notice per card, each with its own BOE link", () => {
		const html = buildMultiReformHtml(
			SITE,
			[
				reform(),
				reform({ id: "BOE-A-1978-31229", source_id: "BOE-A-2026-99999" }),
			],
			"Hay 2 cambios legislativos recientes que pueden afectarte.",
			UNSUB,
			0,
		);
		expect(
			count(
				html,
				"Resumen generado con inteligencia artificial; puede contener errores.",
			),
		).toBe(2);
		expect(html).toContain("txt.php?id=BOE-A-2026-12345");
		expect(html).toContain("txt.php?id=BOE-A-2026-99999");
		expect(html).toContain("No son asesoramiento jurídico");
	});

	test("links point at the canonical reform page, not the /reforma redirect", () => {
		const html = buildSingleReformHtml(SITE, reform(), UNSUB);
		expect(html).toContain(
			`${SITE}/cambios/reforma/?id=BOE-A-2015-11430&date=2026-09-01`,
		);
		expect(html).not.toContain(`${SITE}/reforma?`);
	});

	test("no AI headline or summary: no notice", () => {
		expect(buildAiNotice(reform({ headline: null, summary: null }), 12)).toBe(
			"",
		);
		expect(buildAiNotice(reform({ headline: null }), 12)).toContain(
			"inteligencia artificial",
		);
	});

	test("footer AI note uses the AA-contrast grey", () => {
		const html = buildSingleReformHtml(SITE, reform(), UNSUB);
		const note = html.slice(0, html.indexOf("Los titulares y res"));
		expect(note.slice(note.lastIndexOf("<p "))).toContain("color:#576b80");
	});

	test("source ids are URL-encoded in the BOE link", () => {
		const html = buildSingleReformHtml(
			SITE,
			reform({ source_id: 'X"><script>' }),
			UNSUB,
		);
		expect(html).not.toContain('X"><script>');
	});
});
