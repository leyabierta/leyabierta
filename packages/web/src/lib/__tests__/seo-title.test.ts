// Bing Webmaster Tools flags `<title>` over ~70 characters as "Title too
// long"; Google truncates around 60. The BOE title is the official, legally
// precise name (long, full of subordinate clauses) and is never shortened
// anywhere but here — the `<h1>` and `og:title` keep it in full. See
// seo-title.ts for the full rationale, including two rounds of adversarial
// review (#211): (1) the disambiguator (rank + number, or the full BOE id
// when there is no own number, + jurisdiction when relevant) must never be
// dropped, or distinct laws collapse onto the same <title>; (2) a raw ELI
// code ("es-pv") must never leak into a title — it's mapped to the same
// human jurisdiction name the site already shows, or skipped when the
// subject already names the community.
import { describe, expect, test } from "bun:test";
import { codePointLength } from "../meta-description.ts";
import {
	composeSeoTitle,
	DATE_PHRASE,
	heuristicSubject,
	lawAbbreviation,
	POPULAR_LAW_NAMES,
	SEO_TITLE_MAX,
	SEO_TITLE_SUFFIX,
	SEO_TITLE_TARGET,
	seoLawPageTitle,
	shortLawTitle,
} from "../seo-title.ts";

describe("lawAbbreviation", () => {
	test("rank + number", () => {
		expect(
			lawAbbreviation(
				"ley",
				"Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
				"BOE-A-2014-12328",
				"Impuesto sobre Sociedades",
			),
		).toBe("L 27/2014");
		expect(
			lawAbbreviation(
				"real_decreto_legislativo",
				"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
				"BOE-A-2015-11430",
				"Estatuto de los Trabajadores",
			),
		).toBe("RDLeg 2/2015");
	});

	test("every corpus rank now has an abbreviation (was: only 8 of 15)", () => {
		expect(
			lawAbbreviation(
				"instruccion",
				"Instrucción 1/2021, de 2 de noviembre",
				"BOE-A-2021-1",
				"Algo",
			),
		).toBe("Instr 1/2021");
		expect(
			lawAbbreviation(
				"circular",
				"Circular 3/2022, de 30 de marzo",
				"BOE-A-2022-1",
				"Algo",
			),
		).toBe("Circ 3/2022");
	});

	test("a totally unknown rank still gets a generic fallback abbreviation", () => {
		expect(
			lawAbbreviation(
				"rango-futuro-desconocido",
				"Algo 1/2030",
				"BOE-A-2030-1",
				"Algo",
			),
		).toBe("Norma 1/2030");
	});

	test("no number close to the start → falls back to the full BOE/regional id", () => {
		// The 1882 Ley de Enjuiciamiento Criminal was approved by a dated Real
		// Decreto, not a numbered one. The id is unique, recognizable, and
		// literally what a citizen searches for a specific norm by — unlike a
		// bare rank+date (#211 second review).
		expect(
			lawAbbreviation(
				"real_decreto",
				"Real Decreto de 14 de septiembre de 1882 por el que se aprueba la Ley de Enjuiciamiento Criminal",
				"BOE-A-1882-6036",
				"Ley de Enjuiciamiento Criminal",
			),
		).toBe("BOE-A-1882-6036");
	});

	test("ignores a number that appears deep in the title (someone else's, not this norm's own) and falls back to the id", () => {
		// Real bug found in review: "Real Decreto 463/2020" is a REFERENCE inside
		// this resolución's title, not its own identifier — using it produced 13
		// different norms all keyed "Res 463/2020".
		const abbrev = lawAbbreviation(
			"resolucion",
			"Resolución de 7 de abril de 2020, de la Secretaría de Estado de Derechos Sociales, por la que se publican diversas medidas que afectan a las actividades de juego de la ONCE, como consecuencia de la aprobación del Real Decreto 463/2020, de 14 de marzo, por el que se declara el estado de alarma",
			"BOE-A-2020-4405",
			"Publican diversas medidas",
		);
		expect(abbrev).not.toContain("463/2020");
		expect(abbrev).toBe("BOE-A-2020-4405");
	});

	test("the id fallback disambiguates two same-rank, same-date norms with no number", () => {
		// Real collision found in review: rank+date alone still collided for a
		// same-day batch of unnumbered norms (36 groups / 93 norms in the
		// corpus). The id is the one field guaranteed unique per norm.
		const a = lawAbbreviation(
			"orden",
			"Orden de 16 de febrero de 1989 por la que se aprueba el modelo de acta",
			"BOE-A-1989-4242",
			"Aprueba el modelo de acta",
		);
		const b = lawAbbreviation(
			"orden",
			"Orden de 16 de febrero de 1989 por la que se aprueba otro modelo",
			"BOE-A-1989-4239",
			"Aprueba otro modelo",
		);
		expect(a).not.toBe(b);
		expect(a).toBe("BOE-A-1989-4242");
		expect(b).toBe("BOE-A-1989-4239");
	});

	test("appends the jurisdiction's human name when it isn't 'es' (every comunidad numbers its own laws)", () => {
		// Real collision found in review: Murcia's "Ley 4/2022" and Aragón's
		// "Ley 4/2022" are unrelated laws with the same rank+number.
		expect(
			lawAbbreviation(
				"ley",
				"Ley 4/2022, de 16 de junio, de mecenazgo",
				"BOE-A-2022-13069",
				"Mecenazgo",
				"es-mc",
			),
		).toBe("L 4/2022, Murcia");
		expect(
			lawAbbreviation(
				"ley",
				"Ley 4/2022, de 6 de octubre, de creación",
				"BOE-A-2022-18556",
				"Creación del Colegio",
				"es-ar",
			),
		).toBe("L 4/2022, Aragón");
	});

	test("no raw ELI code ever appears in the disambiguator", () => {
		const abbrev = lawAbbreviation(
			"ley",
			"Ley 4/2022, de 16 de junio, de mecenazgo",
			"BOE-A-2022-13069",
			"Mecenazgo",
			"es-mc",
		);
		expect(abbrev).not.toMatch(/\bes-[a-z]{2}\b/);
	});

	test("skips the jurisdiction when the subject already names the community", () => {
		expect(
			lawAbbreviation(
				"ley",
				"Ley 7/2006, de 12 de mayo, de Museos de Euskadi",
				"BOE-A-2006-1",
				"Museos de Euskadi",
				"es-pv",
			),
		).toBe("L 7/2006");
	});

	test("no jurisdiction suffix for the state level ('es')", () => {
		expect(
			lawAbbreviation(
				"ley",
				"Ley 4/2022, de 25 de febrero, de protección",
				"BOE-A-2022-3198",
				"Protección",
				"es",
			),
		).toBe("L 4/2022");
	});

	test("tolerates a stray space around the number's slash (source typo)", () => {
		expect(
			lawAbbreviation(
				"ley",
				"Ley 8 /1999, de 27 de abril, de Creación de las Escalas",
				"BOE-A-1999-12226",
				"Creación de las Escalas",
			),
		).toBe("L 8/1999");
	});
});

describe("heuristicSubject", () => {
	test("strips the date clause and rank+number+connector prefix", () => {
		expect(
			heuristicSubject(
				"Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
			),
		).toBe("Impuesto sobre Sociedades");
	});

	test("strips 'texto refundido de la Ley' boilerplate down to the subject", () => {
		expect(
			heuristicSubject(
				"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
			),
		).toBe("Estatuto de los Trabajadores");
	});

	test("keeps a direct 'de' subject when there is no del/de la/sobre connector", () => {
		expect(
			heuristicSubject(
				"Real Decreto Legislativo 1/2007, de 16 de noviembre, por el que se aprueba el texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios y otras leyes complementarias",
			),
		).toBe("General para la Defensa de los Consumidores y Usuarios");
	});

	test("strips a 'sobre' connector", () => {
		expect(
			heuristicSubject(
				"Real Decreto Legislativo 6/2015, de 30 de octubre, por el que se aprueba el texto refundido de la Ley sobre Tráfico, Circulación de Vehículos a Motor y Seguridad Vial",
			),
		).toBe("Tráfico, Circulación de Vehículos a Motor y Seguridad Vial");
	});

	test("keeps a title with no boilerplate unchanged", () => {
		expect(heuristicSubject("Constitución Española")).toBe(
			"Constitución Española",
		);
		expect(heuristicSubject("Código Civil")).toBe("Código Civil");
	});

	test("preserves Spanish orthography (accents, ñ)", () => {
		expect(
			heuristicSubject(
				"Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales",
			),
		).toBe(
			"Protección de Datos Personales y garantía de los derechos digitales",
		);
	});

	test("strips a parenthetical aside (would otherwise double up with the disambiguator's own parens)", () => {
		expect(heuristicSubject("Algo con (una aclaración) dentro")).toBe(
			"Algo con dentro",
		);
	});

	test("handles a pre-2000 date with no surrounding commas, and the verb 'publica'", () => {
		// Código Civil / Código de Comercio shape: "Real Decreto de 24 de julio
		// de 1889 por el que se publica el Código Civil" — no comma anywhere
		// around the date (#211 second review: 551 titles like this were left
		// completely unstripped).
		expect(
			heuristicSubject(
				"Real Decreto de 24 de julio de 1889 por el que se publica el Código Civil",
			),
		).toBe("Código Civil");
		// "establecen" is nominalized (verb dropped, object kept) rather than
		// left as a bare conjugated verb — see the "verb-first subjects" tests
		// below (#211 third review).
		expect(
			heuristicSubject(
				"Orden de 18 de junio de 1998 por la que se establecen las condiciones",
			),
		).toBe("Condiciones");
	});

	test("never leaves two different date phrases in the output", () => {
		const subject = heuristicSubject(
			"Ley 42/2015, de 5 de octubre, de reforma de la Ley 1/2000, de 7 de enero, de Enjuiciamiento Civil",
		);
		expect(subject.match(DATE_PHRASE)?.length ?? 0).toBeLessThanOrEqual(1);
	});

	test("drops a leading bare article (headline convention)", () => {
		expect(
			heuristicSubject(
				"Resolución de 8 de mayo de 2024, de la Dirección General de Racionalización, en relación a la declaración de contratación centralizada",
			),
		).not.toMatch(/^(?:La|El|Los|Las)\s/);
	});

	test("drops a leading 'por la que se' left after the rank+number strip", () => {
		expect(
			heuristicSubject(
				"Ley 9/1998, de 21 de abril, por la que se modifica la Ley 37/1992, de 28 de diciembre, del Impuesto sobre el Valor Añadido",
			),
		).not.toMatch(/^Por la que se/i);
	});

	test("drops a mid-subject 'de la Comunidad Autónoma de X' aside", () => {
		expect(
			heuristicSubject(
				"Ley 8/1984, de 22 de diciembre, del Escudo de la Comunidad Autónoma de Cantabria",
			),
		).toBe("Escudo");
	});

	test("tolerates a stray space around the number's slash (source typo)", () => {
		// Real BOE-A-1999-12226: "Ley 8 /1999, de 27 de abril, de Creación de
		// las Escalas…" — the space broke \d+\/\d{4}, silently dropping the
		// number and leaving a mangled subject ("/1999 de Creación de…").
		expect(
			heuristicSubject(
				"Ley 8 /1999, de 27 de abril, de Creación de las Escalas de Profesores Numerarios",
			),
		).toBe("Creación de las Escalas de Profesores Numerarios");
	});

	describe("Traspaso de funciones y servicios — keeps the discriminating tail, not the shared head", () => {
		test("community + materia", () => {
			expect(
				heuristicSubject(
					"Real Decreto 1685/1994, de 22 de julio, sobre traspaso de funciones y servicios de la Administración del Estado a la Comunidad de Castilla y León en materia de espectáculos",
				),
			).toBe("Traspaso a Castilla y León: espectáculos");
			expect(
				heuristicSubject(
					"Real Decreto 2374/1994, de 9 de diciembre, sobre traspaso de funciones y servicios de la Administración del Estado a la Comunidad Autónoma de La Rioja en materia de espectáculos",
				),
			).toBe("Traspaso a La Rioja: espectáculos");
		});
	});

	test("'por que se' tail extraction: keeps the discriminating action, not the issuing body", () => {
		// Real collision found in review: up to 102 norms from the same
		// Dirección General shared the truncated head "Resolución de la
		// Dirección General de X, por la que se…" once the number was dropped.
		expect(
			heuristicSubject(
				"Resolución de 25 de junio de 2013, de la Dirección General de Relaciones con la Administración de Justicia, sobre prestación económica en la situación de incapacidad temporal por contingencias comunes de los miembros de la Carrera Fiscal",
			),
		).not.toMatch(/^Resolución de la Dirección General/i);
	});

	describe("verb-first subjects are nominalized, never left as a bare conjugated verb (#211 third review)", () => {
		test("establece/aprueba/adopta/fija/dicta/publica/dispone: verb dropped, object kept", () => {
			expect(
				heuristicSubject(
					"Orden ABC/1/2020, de 1 de enero, por la que se establecen medidas especiales para el uso de bioetanol",
				),
			).toBe("Medidas especiales para el uso de bioetanol");
			expect(
				heuristicSubject(
					"Real Decreto 1/2020, de 1 de enero, por el que se adoptan medidas de adaptación a la situación de Estado de alarma",
				),
			).toBe("Medidas de adaptación a la situación de Estado de alarma");
			expect(
				heuristicSubject(
					"Orden ABC/2/2020, de 1 de enero, por la que se establece la lista de medicamentos veterinarios",
				),
			).toBe("Lista de medicamentos veterinarios");
		});

		test("regula/regulan → 'Regulación de …'", () => {
			expect(
				heuristicSubject(
					"Orden ABC/3/2020, de 1 de enero, por la que se regula la asignación de recursos a los programas",
				),
			).toBe("Regulación de la asignación de recursos a los programas");
			expect(
				heuristicSubject(
					"Real Decreto-ley 16/1977, de 25 de febrero, por el que se regulan los aspectos penales, administrativos y fiscales de los juegos de suerte, envite o azar",
				),
			).toBe(
				"Regulación de los aspectos penales, administrativos y fiscales de los juegos de suerte, envite o azar",
			);
		});

		test("contracts 'de el' to 'del' (never the ungrammatical 'Regulación de el Observatorio…')", () => {
			expect(
				heuristicSubject(
					"Real Decreto 943/2005, de 29 de julio, por el que se regula el Observatorio de la Pequeña y Mediana Empresa",
				),
			).toBe("Regulación del Observatorio de la Pequeña y Mediana Empresa");
		});

		test("modifica/modifican → 'Modificación de …' (MUST keep — a modifying norm must never read as the norm it modifies)", () => {
			expect(
				heuristicSubject(
					"Ley 9/1998, de 21 de abril, por la que se modifica la Ley 37/1992, de 28 de diciembre, del Impuesto sobre el Valor Añadido",
				),
			).toBe(
				"Modificación de la Ley 37/1992 del Impuesto sobre el Valor Añadido",
			);
		});

		test("other nominalizations: deroga, crea, desarrolla, declara, convoca, activa, reestructura, determina, actualiza, autoriza, aplaza, prorroga, suspende, amplía", () => {
			expect(
				heuristicSubject(
					"Orden ABC/4/2020, de 1 de enero, por la que se activa la Fase 2 del Plan de Desescalada",
				),
			).toBe("Activación de la Fase 2 del Plan de Desescalada");
			expect(
				heuristicSubject(
					"Orden ABC/5/2003, de 1 de enero, por la que se reestructuran los órganos médico periciales",
				),
			).toBe("Reestructuración de los órganos médico periciales");
		});

		test("an unrecognized verb keeps the full 'por la/el que se …' clause rather than a bare conjugated verb", () => {
			const result = heuristicSubject(
				"Orden ABC/6/2020, de 1 de enero, por la que se fomenta la investigación en energías renovables",
			);
			expect(result).toMatch(/^Por la que se fomenta/i);
		});

		test("round-5 verbs: ordena, delimita, constituye, reconoce, extingue… are nominalized too", () => {
			// Real title shapes from the corpus (RD 161/2008, L 5/2008 Murcia, RD 928/1989).
			expect(
				heuristicSubject(
					"Real Decreto 161/2008, de 8 de febrero, por el que se delimita la zona de promoción económica",
				),
			).toBe("Delimitación de la zona de promoción económica");
			expect(
				heuristicSubject(
					"Ley 5/2008, de 25 de junio, por la que se extingue la Cámara Agraria de la Región de Murcia",
				),
			).toBe("Extinción de la Cámara Agraria de la Región de Murcia");
			expect(
				heuristicSubject(
					"Real Decreto 928/1989, de 21 de julio, por el que se constituye el Organismo de cuenca",
				),
			).toBe("Constitución del Organismo de cuenca");
		});

		test("an object starting with a preposition or -mente adverb keeps the clause (no 'Autorización de a…', 'Para los lagomorfos medidas…')", () => {
			expect(
				heuristicSubject(
					"Orden SND/351/2020, de 16 de abril, por la que se autoriza a las Unidades NBQ de las Fuerzas Armadas",
				),
			).toBe(
				"Por la que se autoriza a las Unidades NBQ de las Fuerzas Armadas",
			);
			expect(
				heuristicSubject(
					"Real Decreto 463/2011, de 1 de abril, por el que se establecen para los lagomorfos medidas singulares de aplicación",
				),
			).toMatch(/^Por el que se establecen para los lagomorfos/);
			expect(
				heuristicSubject(
					"Ley 8/2002, de 10 de julio, por la que se reconoce como Universidad privada a la Universidad Católica",
				),
			).toMatch(/^Por la que se reconoce como Universidad/);
			expect(
				heuristicSubject(
					"Orden ABC/7/2020, de 1 de enero, por la que se desarrolla parcialmente la Ley de Aguas",
				),
			).toMatch(/^Por la que se desarrolla parcialmente/);
		});

		test("'con carácter urgente' after a dropped verb is still stripped, not treated as a preposition", () => {
			expect(
				heuristicSubject(
					"Decreto-ley 14/2020, de 26 de mayo, por el que se establecen con carácter extraordinario y urgente medidas para la reactivación del sector",
				),
			).toBe("Medidas para la reactivación del sector");
		});

		test("'de la Comunidad de Castilla y León' aside is removed whole, never leaving '… y León'", () => {
			// Real BOE-A-2002-977 (L 13/2001) and BOE-A-2008-4483 (RD 171/2008).
			expect(
				heuristicSubject(
					"Ley 13/2001, de 20 de diciembre, de Ordenación Farmacéutica de la Comunidad de Castilla y León",
				),
			).toBe("Ordenación Farmacéutica");
			expect(
				heuristicSubject(
					"Real Decreto 171/2008, de 8 de febrero, por el que se delimita la zona de promoción económica de la Comunidad de Castilla y León",
				),
			).toBe("Delimitación de la zona de promoción económica");
		});

		test("bare-preposition-fragment rescue: 'a entidades…' reaches the real ', sobre …' content instead", () => {
			// Real bug found in review: BOILERPLATE_PREFIXES' number+connector
			// entry stripped only the number, leaving "a entidades adscritas a
			// un fondo de garantía de depósitos, sobre aportaciones…" — a
			// broken-looking fragment instead of the real content after ", sobre".
			expect(
				heuristicSubject(
					"Circular 3/2011, de 30 de junio, a entidades adscritas a un fondo de garantía de depósitos, sobre aportaciones adicionales a los fondos de garantía de depósitos",
				),
			).toBe("Aportaciones adicionales a los fondos de garantía de depósitos");
		});

		test("a rank word that is also the norm's own name keeps a bare leading preposition from surviving", () => {
			// Real BOE-A-1983-10613: rank "reglamento", title literally starts
			// with "Reglamento de Organización…" (not "Real Decreto NNNN…") —
			// RANK_WORD_ONLY drops "Reglamento ", which used to leave "de
			// Organización…" (a fragment) instead of continuing to strip it.
			expect(
				heuristicSubject(
					"Reglamento de Organización y Funcionamiento del Defensor del Pueblo, aprobado por las Mesas del Congreso y del Senado, a propuesta del Defensor del Pueblo, en su reunión conjunta de 6 de abril de 1983",
				),
			).not.toMatch(/^(?:A|De|Por|Con|Sin|Ante|Bajo|Desde|Hasta|Según|Tras)\s/);
		});
	});
});

describe("shortLawTitle", () => {
	const CASES: {
		id: string;
		rango: string;
		titulo: string;
		jurisdiccion?: string;
	}[] = [
		{
			// Not the curated BOE-A-2014-12328 id on purpose: exercises the plain
			// heuristic path (no popular-name override) for this assertion.
			id: "BOE-A-2014-99999",
			rango: "ley",
			titulo: "Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
		},
		{
			id: "BOE-A-2018-16673",
			rango: "ley_organica",
			titulo:
				"Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales",
		},
		{
			id: "BOE-A-2007-20555",
			rango: "real_decreto_legislativo",
			titulo:
				"Real Decreto Legislativo 1/2007, de 16 de noviembre, por el que se aprueba el texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios y otras leyes complementarias",
		},
		{
			id: "BOE-A-2015-11722",
			rango: "real_decreto_legislativo",
			titulo:
				"Real Decreto Legislativo 6/2015, de 30 de octubre, por el que se aprueba el texto refundido de la Ley sobre Tráfico, Circulación de Vehículos a Motor y Seguridad Vial",
		},
		{
			id: "BOE-A-1978-31229",
			rango: "constitucion",
			titulo: "Constitución Española",
		},
	];

	test("appends the disambiguator in parentheses", () => {
		expect(shortLawTitle(CASES[0]!)).toBe(
			"Impuesto sobre Sociedades (L 27/2014)",
		);
	});

	test("uses the popular curated name when available", () => {
		expect(POPULAR_LAW_NAMES["BOE-A-2015-11430"]).toBeDefined();
		expect(
			shortLawTitle({
				id: "BOE-A-2015-11430",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
			}),
		).toBe("Estatuto de los Trabajadores (RDLeg 2/2015)");
	});

	test("Código Civil / Código de Comercio / Ley Hipotecaria / Ley Concursal are curated (no own number to anchor on) — id dropped, the curated name is already unique", () => {
		expect(
			shortLawTitle({
				id: "BOE-A-1889-4763",
				rango: "real_decreto",
				titulo:
					"Real Decreto de 24 de julio de 1889 por el que se publica el Código Civil",
			}),
		).toBe("Código Civil");
		expect(
			shortLawTitle({
				id: "BOE-A-1885-6627",
				rango: "real_decreto",
				titulo:
					"Real Decreto de 22 de agosto de 1885 por el que se publica el Código de Comercio",
			}),
		).toBe("Código de Comercio");
	});

	test("no curated name contains '(' — never doubles up with the disambiguator's parens", () => {
		for (const [id, name] of Object.entries(POPULAR_LAW_NAMES)) {
			expect(name.includes("(")).toBe(false);
			const title = shortLawTitle({ id, rango: "ley", titulo: "Ley 1/2000" });
			expect(title.match(/\(/g)?.length ?? 0).toBe(1);
			expect(title.match(/\)/g)?.length ?? 0).toBe(1);
		}
	});

	test("truncates the subject, never the disambiguator, to fit a tight budget", () => {
		for (const c of CASES) {
			const title = shortLawTitle(c, 45);
			expect(codePointLength(title)).toBeLessThanOrEqual(45);
			// A curated name with no own number (Constitución Española) drops the
			// disambiguator entirely — see the dedicated test below — so it has
			// no "(abbrev)" to assert on here.
			if (c.id === "BOE-A-1978-31229") continue;
			const curated = POPULAR_LAW_NAMES[c.id];
			const subject = curated ?? heuristicSubject(c.titulo);
			const abbrev = lawAbbreviation(
				c.rango,
				c.titulo,
				c.id,
				subject,
				c.jurisdiccion,
			);
			expect(title).toContain(`(${abbrev})`);
		}
	});

	test("keeps the abbreviation even when the subject must be cut to almost nothing", () => {
		const long = shortLawTitle(
			{
				id: "x",
				rango: "ley",
				titulo:
					"Ley 1/2005, de 9 de marzo, por la que se regula el régimen del comercio de derechos de emisión de gases de efecto invernadero",
			},
			45,
		);
		expect(long).toContain("(L 1/2005)");
		expect(codePointLength(long)).toBeLessThanOrEqual(45);
	});

	test("a NON-curated title with no boilerplate and no number still gets the id disambiguator (uniqueness is never optional)", () => {
		// A title that doesn't start with a known rank word on purpose — one
		// that does (e.g. "Reglamento de X") legitimately loses that leading
		// word to RANK_WORD_ONLY, same as every other rank-led title.
		expect(
			shortLawTitle({
				id: "BOE-A-1900-1",
				rango: "ley",
				titulo: "Fuero de los Españoles",
			}),
		).toBe("Fuero de los Españoles (BOE-A-1900-1)");
	});

	test("a CURATED title with no own number drops the id disambiguator — the curated name is unique by construction", () => {
		// Constitución Española is curated precisely so this can drop the id:
		// "Constitución Española (BOE-A-1978-31229)" is needlessly technical
		// for a name this globally unrecognizable (#211 third review).
		expect(shortLawTitle(CASES[4]!)).toBe("Constitución Española");
	});

	describe("uniqueness fixtures (real collisions found in the #211 review)", () => {
		test("three 'traspaso' Real Decretos to three different comunidades stay distinct", () => {
			const laws = [
				{
					id: "BOE-A-1994-20096",
					rango: "real_decreto",
					titulo:
						"Real Decreto 1685/1994, de 22 de julio, sobre traspaso de funciones y servicios de la Administración del Estado a la Comunidad de Castilla y León en materia de espectáculos",
					jurisdiccion: "es",
				},
				{
					id: "BOE-A-1994-28721",
					rango: "real_decreto",
					titulo:
						"Real Decreto 2374/1994, de 9 de diciembre, sobre traspaso de funciones y servicios de la Administración del Estado a la Comunidad Autónoma de La Rioja en materia de espectáculos",
					jurisdiccion: "es",
				},
				{
					id: "BOE-A-1995-4352",
					rango: "real_decreto",
					titulo:
						"Real Decreto 122/1995, de 27 de enero, sobre traspaso de funciones y servicios de la Administración del Estado a la Comunidad Autónoma de las Islas Baleares en materia de espectáculos",
					jurisdiccion: "es",
				},
			];
			const titles = laws.map((l) => seoLawPageTitle(l));
			expect(new Set(titles).size).toBe(titles.length);
			expect(titles[0]).toBe(
				"Traspaso a Castilla y León: espectáculos (RD 1685/1994) — Ley Abierta",
			);
		});

		test("the same rank+number in three different jurisdictions stays distinct, with human names", () => {
			const laws = [
				{
					id: "BOE-A-2022-13069",
					rango: "ley",
					titulo:
						"Ley 4/2022, de 16 de junio, de mecenazgo de la Región de Murcia y de modificación del Decreto Legislativo 1/2010, de 5 de noviembre, por el que se aprueba el texto refundido de las disposiciones legales vigentes en la Región de Murcia en materia de tributos cedidos",
					jurisdiccion: "es-mc",
				},
				{
					id: "BOE-A-2022-18556",
					rango: "ley",
					titulo:
						"Ley 4/2022, de 6 de octubre, de creación del Colegio Profesional de Higienistas Dentales de Aragón",
					jurisdiccion: "es-ar",
				},
				{
					id: "BOE-A-2022-3198",
					rango: "ley",
					titulo:
						"Ley 4/2022, de 25 de febrero, de protección de los consumidores y usuarios frente a situaciones de vulnerabilidad social y económica",
					jurisdiccion: "es",
				},
			];
			const titles = laws.map((l) => seoLawPageTitle(l));
			expect(new Set(titles).size).toBe(titles.length);
			for (const t of titles) expect(t).not.toMatch(/\bes-[a-z]{2}\b/);
		});

		test("two COVID-era resoluciones that both mention 'Real Decreto 463/2020' stay distinct", () => {
			const laws = [
				{
					id: "BOE-A-2020-4405",
					rango: "resolucion",
					titulo:
						"Resolución de 7 de abril de 2020, de la Secretaría de Estado de Derechos Sociales, por la que se publican diversas medidas que afectan a las actividades de juego de la ONCE, como consecuencia de la aprobación del Real Decreto 463/2020, de 14 de marzo, por el que se declara el estado de alarma para la gestión de la situación de crisis sanitaria ocasionada por el COVID-19",
					jurisdiccion: "es",
				},
				{
					id: "BOE-A-2020-4063",
					rango: "resolucion",
					titulo:
						"Resolución de 20 de marzo de 2020, de la Comisión Nacional del Mercado de Valores, sobre la suspensión de plazos administrativos prevista en el Real Decreto 463/2020, relativo al estado de alarma",
					jurisdiccion: "es",
				},
			];
			const titles = laws.map((l) => seoLawPageTitle(l));
			expect(new Set(titles).size).toBe(titles.length);
		});
	});
});

describe("composeSeoTitle", () => {
	test("appends the suffix when it fits", () => {
		expect(composeSeoTitle("Constitución Española")).toBe(
			`Constitución Española${SEO_TITLE_SUFFIX}`,
		);
	});

	test("drops the suffix rather than truncating the core when it doesn't fit", () => {
		const core =
			"Financiación del sistema de transporte público de Cataluña (L 21/2015)"; // 72 chars
		expect(codePointLength(core)).toBeGreaterThan(
			SEO_TITLE_MAX - SEO_TITLE_SUFFIX.length,
		);
		const result = composeSeoTitle(core);
		expect(result).toBe(core);
		expect(result.endsWith(SEO_TITLE_SUFFIX)).toBe(false);
	});

	test("truncates only as a last resort, when even the bare core overflows max", () => {
		const veryLong = "Ley de ".repeat(20).trim();
		const result = composeSeoTitle(veryLong);
		expect(codePointLength(result)).toBeLessThanOrEqual(SEO_TITLE_MAX);
		expect(result.endsWith("…")).toBe(true);
	});

	test("never produces a dangling connector word right before the ellipsis", () => {
		const veryLong =
			"Por la que se modifican determinados artículos de la Ley 25/1983, de 26 de diciembre, de Incompatibilidades de Altos Cargos";
		const result = composeSeoTitle(veryLong, 40);
		expect(result.endsWith("…")).toBe(true);
		expect(result).not.toMatch(/\s(?:de|del|la|el|los|las|y|o|en|a)…$/i);
	});
});

describe("seoLawPageTitle", () => {
	test("hard cap: never exceeds SEO_TITLE_MAX for any of the flagged laws", () => {
		const flagged: { id: string; rango: string; titulo: string }[] = [
			{
				id: "BOE-A-2014-12328",
				rango: "ley",
				titulo:
					"Ley 27/2014, de 27 de noviembre, del Impuesto sobre Sociedades",
			},
			{
				id: "BOE-A-2015-11430",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
			},
			{
				id: "BOE-A-2018-16673",
				rango: "ley_organica",
				titulo:
					"Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales",
			},
			{
				id: "BOE-A-2007-20555",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 1/2007, de 16 de noviembre, por el que se aprueba el texto refundido de la Ley General para la Defensa de los Consumidores y Usuarios y otras leyes complementarias",
			},
			{
				id: "BOE-A-2015-11722",
				rango: "real_decreto_legislativo",
				titulo:
					"Real Decreto Legislativo 6/2015, de 30 de octubre, por el que se aprueba el texto refundido de la Ley sobre Tráfico, Circulación de Vehículos a Motor y Seguridad Vial",
			},
		];
		for (const law of flagged) {
			const title = seoLawPageTitle(law);
			expect(codePointLength(title)).toBeLessThanOrEqual(SEO_TITLE_MAX);
			// Sanity: comfortably shorter than the live (buggy) titles it replaces.
			expect(codePointLength(title)).toBeLessThan(codePointLength(law.titulo));
			// No double parens (#211 review).
			expect(title.match(/\(/g)?.length ?? 0).toBeLessThanOrEqual(1);
		}
	});

	test("Constitución Española: short, unmodified in substance, no id needed (curated + unique)", () => {
		expect(
			seoLawPageTitle({
				id: "BOE-A-1978-31229",
				rango: "constitucion",
				titulo: "Constitución Española",
			}),
		).toBe("Constitución Española — Ley Abierta");
	});

	test("LOPDGDD has no double parentheses", () => {
		const title = seoLawPageTitle({
			id: "BOE-A-2018-16673",
			rango: "ley_organica",
			titulo:
				"Ley Orgánica 3/2018, de 5 de diciembre, de Protección de Datos Personales y garantía de los derechos digitales",
		});
		expect(title.match(/\(/g)?.length ?? 0).toBe(1);
		expect(title).not.toContain(") (");
	});

	test("target: the curated/short cases land at or under SEO_TITLE_TARGET", () => {
		const title = seoLawPageTitle({
			id: "BOE-A-2015-11430",
			rango: "real_decreto_legislativo",
			titulo:
				"Real Decreto Legislativo 2/2015, de 23 de octubre, por el que se aprueba el texto refundido de la Ley del Estatuto de los Trabajadores",
		});
		expect(codePointLength(title)).toBeLessThanOrEqual(SEO_TITLE_TARGET);
	});

	test("no title contains a raw ELI jurisdiction code", () => {
		const title = seoLawPageTitle({
			id: "BOE-A-2022-13069",
			rango: "ley",
			titulo: "Ley 4/2022, de 16 de junio, de mecenazgo de la Región de Murcia",
			jurisdiccion: "es-mc",
		});
		expect(title).not.toMatch(/\bes-[a-z]{2}\b/);
		expect(title).toContain("Región de Murcia");
	});
});
