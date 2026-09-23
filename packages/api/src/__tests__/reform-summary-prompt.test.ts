import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import {
	type BlockDiff,
	buildPrompt,
	formatBlockChange,
	getSourceInfo,
	isOmnibusSource,
	MAX_CHANGES_CHARS,
	type SourceInfo,
} from "../scripts/reform-summary-prompt.ts";

const FILLER = "Texto sin cambios que se repite en el artículo. ".repeat(40);
const BEFORE = `Artículo 12. Plazos.\n\n1. Las solicitudes se presentarán en el plazo de **tres meses** desde la convocatoria. ${FILLER}2. La resolución se dictará en seis meses.`;
const AFTER = BEFORE.replace("tres meses", "cuatro meses").replace(
	"seis meses.",
	"seis meses. El silencio será desestimatorio.",
);

describe("formatBlockChange", () => {
	test("shows only the changed words with context, not the first 500 chars", () => {
		const out = formatBlockChange(BEFORE, AFTER);
		expect(out).toContain("[-tres-] {+cuatro+}");
		expect(out).toContain("{+El silencio será desestimatorio.+}");
		// The unchanged middle is elided.
		expect(out).toContain("…");
		expect(out.length).toBeLessThan(600);
	});

	test("a change deep inside a long article is still visible", () => {
		const long = `Artículo 1. ${"Texto largo sin cambios. ".repeat(200)}La cuantía será de 100 euros.`;
		const out = formatBlockChange(long, long.replace("100 euros", "150 euros"));
		expect(out).toContain("[-100-] {+150+}");
	});

	test("identical text (after dropping markdown and whitespace) says so", () => {
		expect(formatBlockChange("Uno **dos**  tres.", "Uno dos\ntres.")).toContain(
			"el texto no cambia",
		);
	});

	test("a near-total rewrite falls back to both versions", () => {
		const out = formatBlockChange(
			"El órgano competente es la Consejería.",
			"Se crea la Agencia Autonómica de Evaluación con personalidad jurídica propia.",
		);
		expect(out).toContain("reescrito casi por completo");
		expect(out).toContain("antes: El órgano competente es la Consejería.");
		expect(out).toContain("ahora: Se crea la Agencia");
	});

	test("respects the character budget", () => {
		const a = Array.from({ length: 300 }, (_, i) => `palabra${i}`).join(" ");
		const b = Array.from({ length: 300 }, (_, i) =>
			i % 3 === 0 ? `cambio${i}` : `palabra${i}`,
		).join(" ");
		expect(formatBlockChange(a, b, 400).length).toBeLessThanOrEqual(401);
	});
});

const source = (over: Partial<SourceInfo> = {}): SourceInfo => ({
	id: "BOE-A-2020-1",
	title: "Ley 1/2020, de medidas",
	lawsModified: 1,
	materiaCount: 3,
	...over,
});

describe("omnibus is decided by the law that makes the change", () => {
	test("thresholds", () => {
		expect(isOmnibusSource(source())).toBe(false);
		expect(isOmnibusSource(source({ lawsModified: 10 }))).toBe(true);
		expect(isOmnibusSource(source({ materiaCount: 15 }))).toBe(true);
	});

	let db: Database;
	beforeEach(() => {
		db = new Database(":memory:");
		createSchema(db);
		const norm = db.prepare(
			"INSERT INTO norms (id, title, country, rank, published_at, status) VALUES (?, ?, 'es', 'ley', '2020-01-01', 'vigente')",
		);
		norm.run("CP", "Código Penal");
		norm.run(
			"OMNI",
			"Ley de medidas fiscales, administrativas y del orden social",
		);
		for (let i = 0; i < 12; i++) norm.run(`L${i}`, `Ley ${i}`);
		const reform = db.prepare(
			"INSERT INTO reforms (norm_id, date, source_id) VALUES (?, '2020-06-01', ?)",
		);
		for (let i = 0; i < 12; i++) reform.run(`L${i}`, "OMNI");
		reform.run("CP", "SMALL");
		// The modified law has many materias: that must not matter any more.
		const materia = db.prepare(
			"INSERT INTO materias (norm_id, materia) VALUES ('CP', ?)",
		);
		for (let i = 0; i < 20; i++) materia.run(`Materia ${i}`);
	});
	afterEach(() => db.close());

	test("getSourceInfo counts the distinct laws a source modifies", () => {
		expect(getSourceInfo(db, "OMNI")).toEqual({
			id: "OMNI",
			title: "Ley de medidas fiscales, administrativas y del orden social",
			lawsModified: 12,
			materiaCount: 0,
		});
		const small = getSourceInfo(db, "SMALL");
		expect(small.title).toBeNull();
		expect(isOmnibusSource(small)).toBe(false);
	});

	test("a normal law reforming a law with many materias gets no omnibus note", () => {
		const { user } = buildPrompt(
			{
				norm_id: "CP",
				title: "Código Penal",
				rank: "ley_organica",
				date: "2020-06-01",
				source_id: "SMALL",
			},
			[],
			Array.from({ length: 20 }, (_, i) => `Materia ${i}`),
			false,
			getSourceInfo(db, "SMALL"),
		);
		expect(user).not.toContain("ómnibus");
		expect(user).toContain("Norma que introduce el cambio: SMALL");
	});

	test("an omnibus source gets the note, naming how many laws it modifies", () => {
		const { user } = buildPrompt(
			{
				norm_id: "L1",
				title: "Ley 1",
				rank: "ley",
				date: "2020-06-01",
				source_id: "OMNI",
			},
			[],
			[],
			false,
			getSourceInfo(db, "OMNI"),
		);
		expect(user).toContain("ley ómnibus que modifica 12 leyes distintas");
		expect(user).toContain(
			"Norma que introduce el cambio: Ley de medidas fiscales, administrativas y del orden social",
		);
	});
});

describe("buildPrompt changes section", () => {
	const reform = {
		norm_id: "N",
		title: "Ley",
		rank: "ley",
		date: "2021-01-01",
		source_id: "S",
	};
	const modified = (i: number): BlockDiff => ({
		block_id: `a${i}`,
		title: `Artículo ${i}`,
		change_type: "modified",
		previous_text: BEFORE,
		current_text: AFTER,
	});

	test("explains the diff notation in the system prompt", () => {
		const { system } = buildPrompt(reform, [modified(1)], [], false, source());
		expect(system).toContain("[-texto-]");
		expect(system).toContain("{+texto+}");
	});

	test("caps the total size and lists the remaining articles by title", () => {
		const diffs = Array.from({ length: 30 }, (_, i) => modified(i + 1));
		const { user } = buildPrompt(reform, diffs, [], false, source());
		expect(user.length).toBeLessThan(MAX_CHANGES_CHARS + 2000);
		expect(user).toMatch(/\(y \d+ artículos más modificados: Artículo/);
	});

	test("new blocks show their text", () => {
		const { user } = buildPrompt(
			reform,
			[
				{
					block_id: "a9",
					title: "Artículo 9",
					change_type: "new",
					previous_text: "",
					current_text: "Se crea el registro de mediadores.",
				},
			],
			[],
			false,
			source(),
		);
		expect(user).toContain(
			"[NUEVO] Artículo 9: Se crea el registro de mediadores.",
		);
	});
});
