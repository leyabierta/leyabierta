// Bing Webmaster Tools flags `<meta name="description">` outside 25–160
// characters (Google truncates snippets around the same ceiling). This is
// the shared helper: `ensureMetaDescription` is the safety net wired into
// every page via Base.astro, `composeLawDescription` is the smarter builder
// for the law ficha page (lead with the citizen summary, drop status/
// department before truncating).
import { describe, expect, test } from "bun:test";
import {
	codePointLength,
	composeLawDescription,
	ensureMetaDescription,
	FALLBACK_DESCRIPTION,
	MAX_DESCRIPTION_LENGTH,
	MIN_DESCRIPTION_LENGTH,
	normalizeWhitespace,
	truncateAtWordBoundary,
} from "../lib/meta-description.ts";

describe("truncateAtWordBoundary", () => {
	test("leaves short text untouched", () => {
		expect(truncateAtWordBoundary("hola mundo", 160)).toBe("hola mundo");
	});

	test("cuts at the last word boundary within budget and appends an ellipsis", () => {
		const text =
			"Es la norma básica que regula tus derechos y deberes en el trabajo diario";
		const out = truncateAtWordBoundary(text, 40);
		expect(codePointLength(out)).toBeLessThanOrEqual(40);
		expect(out.endsWith("…")).toBe(true);
		// Never cuts mid-word: the character right before "…" is not glued to
		// a word fragment from the next word in the source.
		expect(text.startsWith(out.slice(0, -1).trimEnd())).toBe(true);
	});

	test("does not leave trailing punctuation or separators before the ellipsis", () => {
		const out = truncateAtWordBoundary(
			"Ley de Empleo · En vigor · Ministerio",
			20,
		);
		expect(out.endsWith("…")).toBe(true);
		expect(out).not.toMatch(/[\s,.;:·—–-]…$/);
	});

	test("falls back to a hard cut when the first word alone blows the budget", () => {
		const out = truncateAtWordBoundary(
			"Supercalifragilisticoexpialidocioso resto del texto",
			10,
		);
		expect(codePointLength(out)).toBeLessThanOrEqual(10);
		expect(out.endsWith("…")).toBe(true);
	});

	test("counts accented and multibyte characters as single Unicode code points", () => {
		const text = "áéíóúñü ".repeat(10); // 8 chars * 10 = 80 code points
		expect(codePointLength(text)).toBe(80);
		const out = truncateAtWordBoundary(text, 30);
		expect(codePointLength(out)).toBeLessThanOrEqual(30);
	});
});

describe("normalizeWhitespace", () => {
	test("collapses newlines and repeated spaces", () => {
		expect(normalizeWhitespace("  hola \n\n  mundo   ")).toBe("hola mundo");
	});
});

describe("ensureMetaDescription", () => {
	test("keeps a description already within 25–160 chars", () => {
		const text =
			"Política de cookies de Ley Abierta: qué cookies utilizamos y cómo gestionarlas.";
		expect(ensureMetaDescription(text)).toBe(text);
	});

	test("falls back when the input is empty", () => {
		expect(ensureMetaDescription("")).toBe(FALLBACK_DESCRIPTION);
		expect(ensureMetaDescription(undefined)).toBe(FALLBACK_DESCRIPTION);
		expect(ensureMetaDescription(null)).toBe(FALLBACK_DESCRIPTION);
	});

	test("falls back when the input is shorter than the 25-char minimum", () => {
		const out = ensureMetaDescription("Ley corta");
		expect(out).toBe(FALLBACK_DESCRIPTION);
		expect(codePointLength(out)).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
	});

	test("truncates input longer than 160 chars at a word boundary", () => {
		// Real example from the bug report (RDLeg 2/2015), 215 chars.
		const text =
			"RDLeg 2/2015 · Es la norma básica que regula tus derechos y deberes en el trabajo, desde el contrato hasta el despido, pasando por el salario, la jornada y las vacaciones. · En vigor · Ministerio de Empleo y Seguridad Social";
		const out = ensureMetaDescription(text);
		expect(codePointLength(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
		expect(out.endsWith("…")).toBe(true);
	});

	test("unescapes HTML entities before measuring length", () => {
		// Without unescaping, "&amp;" (5 chars) reads as 1 char shorter than
		// what a visitor (or Bing) actually sees ("&", 1 char) — the opposite
		// direction of the bug, but the same principle: measure the real text.
		const text =
			"Empresas &amp; autónomos: qué cambia con la nueva ley de creación de empresas en España este año";
		const out = ensureMetaDescription(text);
		expect(out).not.toContain("&amp;");
		expect(out).toContain("&");
	});

	test("a custom fallback is used verbatim when it is itself in range", () => {
		const fallback = "Resumen no disponible todavía para esta ley en concreto.";
		expect(ensureMetaDescription("", fallback)).toBe(fallback);
	});
});

describe("composeLawDescription", () => {
	test("keeps every part when the joined string fits", () => {
		const out = composeLawDescription({
			abbreviation: "RD 344/2020",
			summary: "Regula la digitalización de los procesos educativos.",
			status: "En vigor",
			department: "Ministerio de Educación",
		});
		expect(out).toBe(
			"RD 344/2020 · Regula la digitalización de los procesos educativos. · En vigor · Ministerio de Educación",
		);
		expect(codePointLength(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
	});

	test("drops department first when over budget, keeping status and abbreviation", () => {
		const out = composeLawDescription({
			abbreviation: "RDLeg 2/2015",
			summary:
				"Es la norma básica que regula tus derechos y deberes en el trabajo, desde el contrato hasta el despido",
			status: "En vigor",
			department: "Ministerio de Empleo y Seguridad Social",
		});
		expect(out).not.toContain("Ministerio");
		expect(out).toContain("En vigor");
		expect(out).toContain("RDLeg 2/2015");
		expect(codePointLength(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
	});

	test("drops status too when department alone wasn't enough", () => {
		const out = composeLawDescription({
			abbreviation: "RDLeg 2/2015",
			summary:
				"Es la norma básica que regula tus derechos y deberes en el trabajo, desde el contrato hasta el despido, pasando por el salario y jornada",
			status: "En vigor",
			department: "Ministerio de Empleo y Seguridad Social",
		});
		expect(out).not.toContain("Ministerio");
		expect(out).not.toContain("En vigor");
		expect(out).toContain("RDLeg 2/2015");
		expect(codePointLength(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
	});

	test("truncates the summary at a word boundary as a last resort, keeping a short abbreviation", () => {
		const out = composeLawDescription({
			abbreviation: "CE",
			summary:
				"Es la norma suprema que organiza el Estado español, garantiza nuestros derechos y libertades y establece cómo funcionan las instituciones públicas y sus relaciones con la ciudadanía en todos los ámbitos de la vida democrática",
			status: "En vigor",
			department: "Cortes Generales",
		});
		expect(codePointLength(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
		expect(out.startsWith("CE ·")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
	});

	test("works with no abbreviation, status or department (fallback-summary case)", () => {
		const out = composeLawDescription({ summary: "Real Decreto" });
		// "Real Decreto" alone is under 25 chars — falls back rather than
		// publishing a too-short description.
		expect(codePointLength(out)).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
	});

	test("the BOE-A-2020-344 fallback case (no citizen summary yet) stays in range", () => {
		const out = composeLawDescription({
			abbreviation: "RD 702/2019",
			summary: "Real Decreto",
			status: "En vigor",
			department: "Ministerio de Educación y Formación Profesional",
		});
		expect(codePointLength(out)).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
		expect(codePointLength(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
	});

	test("never exceeds the max even for a pathologically long summary with no other parts", () => {
		const out = composeLawDescription({
			summary: "palabra ".repeat(60).trim(),
		});
		expect(codePointLength(out)).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
		expect(out.endsWith("…")).toBe(true);
	});
});
