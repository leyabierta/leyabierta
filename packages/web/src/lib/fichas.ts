/**
 * Hand-reviewed citizen "fichas": one Markdown file per law in
 * src/data/fichas/<id>.md (frontmatter + body). When a law has one, its page
 * /leyes/<id>/ shows it first and takes its SEO title and description from it,
 * and every law listed in its `modifica` shows a notice linking to it.
 *
 * Fichas are reviewed by a person, so an invalid file must fail the build
 * loudly rather than silently disappear from the page.
 *
 * Reading the directory is the only side effect (loadFichas); everything else
 * is pure so it can be tested with in-memory sources.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { z } from "zod";
import { formatDate } from "./law-labels.ts";
import { codePointLength } from "./meta-description.ts";
import { composeSeoTitle, SEO_TITLE_MAX } from "./seo-title.ts";

/** Google shows ~155 characters of a meta description. */
export const FICHA_DESCRIPTION_MAX = 155;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NORM_ID = /^[A-Z][A-Z0-9]*-[A-Z0-9-]+$/;

const isoDate = z.string().regex(ISO_DATE, "fecha AAAA-MM-DD");

/**
 * Tone of a status badge and of a calendar milestone: done (blue), in force
 * now (green) or pending (amber, dashed in the timeline).
 */
export const FICHA_TONES = ["hecho", "vigente", "pendiente"] as const;
export type FichaTone = (typeof FICHA_TONES)[number];
const tone = z.enum(FICHA_TONES);

const fichaFrontmatter = z.object({
	identificador: z.string().regex(NORM_ID),
	/** Short name used in notices: "Real Decreto-ley 27/2026". */
	nombre_corto: z.string().min(1),
	etiquetas: z.array(z.string().min(1)).min(1),
	titular: z.string().min(1),
	subtitulo: z.string().min(1),
	/** Status badges under the titular. A plain string is a "hecho" (blue) badge. */
	estado: z
		.array(
			z.preprocess(
				(v) => (typeof v === "string" ? { texto: v, tono: "hecho" } : v),
				z.object({ texto: z.string().min(1), tono: tone }),
			),
		)
		.default([]),
	/** Key figures shown as cards under the header ("5 años" + what it means). */
	cifras: z
		.array(z.object({ valor: z.string().min(1), texto: z.string().min(1) }))
		.default([]),
	/**
	 * Calendar milestones, shown at the top of the "Desde cuándo…" section.
	 * `fecha` is free text ("29 sep 2026", "30 días tras su promulgación").
	 */
	hitos: z
		.array(
			z.object({
				fecha: z.string().min(1),
				titulo: z.string().min(1),
				texto: z.string().min(1),
				estado: tone,
				/** Legal reference, shown like the bracketed ones in the body. */
				ref: z.string().min(1).optional(),
			}),
		)
		.default([]),
	/** Page `<title>` without the site suffix. */
	seo_titulo: z.string().min(1),
	descripcion: z
		.string()
		.min(25)
		.refine((s) => codePointLength(s) <= FICHA_DESCRIPTION_MAX, {
			message: `descripcion > ${FICHA_DESCRIPTION_MAX} caracteres`,
		}),
	/** Date of the last human review (JSON-LD dateModified). */
	revisado: isoDate,
	/** Date the law came into force (used in the notices). */
	en_vigor: isoDate,
	modifica: z
		.array(
			z.object({
				identificador: z.string().regex(NORM_ID),
				articulos: z.array(z.string().min(1)).min(1),
				/** Date the BOE consolidated text started to include the change, if checked. */
				boe_consolidado: isoDate.optional(),
			}),
		)
		.default([]),
});

export type FichaFrontmatter = z.infer<typeof fichaFrontmatter>;

export interface Ficha extends FichaFrontmatter {
	/** Body parsed into the known sections, in file order (see parseSections). */
	sections: FichaSection[];
	/** Raw body Markdown (hashed for lastmod). */
	body: string;
}

// ── Structured model ──────────────────────────────────────────────────────

/** Marks allowed right after an item's bold title: `**Título.** {.duda} …`. */
export const FICHA_ITEM_FLAGS = ["duda"] as const;
export type FichaItemFlag = (typeof FICHA_ITEM_FLAGS)[number];

/** One list item of the body. All HTML is inline and has its references marked. */
export interface FichaItem {
	/** Short card title: the item's leading bold text, without its final period. */
	title?: string;
	/** The rest of the item. */
	html: string;
	flags: FichaItemFlag[];
	/** Nested list ("excepciones a)–f)"), one inline HTML string per item. */
	subitems: string[];
}

export type FichaAudienceIcon = "casa" | "llave" | "persona";

interface SectionBase {
	/** Anchor (unique on the law page, which has its own #resumen). */
	id: string;
	/** The "##" heading, as written. */
	title: string;
	/** Text in the "En esta página" index; null keeps it out of the index. */
	tocLabel: string | null;
	/** Small label above the heading ("Antes y ahora"), if the layout has one. */
	kicker: string | null;
}

export type FichaSection =
	/** "## En 30 segundos": one list, each item a numbered card. */
	| (SectionBase & { kind: "summary"; items: FichaItem[] })
	/** "## Qué cambia": one table (row header + columns) and source notes. */
	| (SectionBase & {
			kind: "changes";
			/** Text of the empty top-left header (screen readers only). */
			corner: string;
			columns: string[];
			rows: { topic: string; cells: string[] }[];
			notes: string[];
	  })
	/** "## Qué significa para ti": one "###" group per audience, each a list. */
	| (SectionBase & {
			kind: "audiences";
			groups: {
				title: string;
				icon: FichaAudienceIcon;
				items: FichaItem[];
			}[];
	  })
	/** "## Desde cuándo…": the frontmatter `hitos`, then one card per item. */
	| (SectionBase & { kind: "dates"; items: FichaItem[] })
	/** "## Estado", "## Qué no hace", "## Nota" (the footer): paragraphs. */
	| (SectionBase & {
			kind: "status" | "limits" | "note";
			paragraphs: string[];
	  })
	/** Any other "##": rendered as plain Markdown. */
	| (SectionBase & { kind: "prose"; html: string });

export type FichaSectionKind = FichaSection["kind"];

interface KnownSection {
	kind: Exclude<FichaSectionKind, "prose">;
	match: RegExp;
	id: string;
	/** Index text: the heading itself, a shorter label, or left out. */
	toc: "heading" | "none" | { label: string };
	/** Small label above the heading. */
	kicker?: string;
}

/** Headings with their own layout. Matched case-insensitively on the "##" text. */
const KNOWN_SECTIONS: KnownSection[] = [
	{
		kind: "summary",
		match: /^en \d+ segundos$/,
		id: "ficha-resumen",
		toc: "heading",
		kicker: "Resumen ciudadano",
	},
	{
		kind: "changes",
		match: /^qué cambia$/,
		id: "ficha-cambios",
		toc: "heading",
		kicker: "Antes y ahora",
	},
	{
		kind: "audiences",
		match: /^qué significa para ti$/,
		id: "ficha-para-ti",
		toc: "heading",
		kicker: "Según tu situación",
	},
	{
		kind: "dates",
		match: /^desde cuándo/,
		id: "ficha-fechas",
		toc: { label: "Desde cuándo" },
		kicker: "Calendario",
	},
	{ kind: "status", match: /^estado$/, id: "ficha-estado", toc: "heading" },
	{ kind: "limits", match: /^qué no hace$/, id: "ficha-no-hace", toc: "none" },
	{ kind: "note", match: /^nota$/, id: "ficha-nota", toc: "none" },
];

function slug(s: string): string {
	return s
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Icon of an audience group, from its heading ("Si vives de alquiler"). */
export function audienceIcon(title: string): FichaAudienceIcon {
	const t = title.toLowerCase();
	if (/vives de alquiler|inquilin/.test(t)) return "casa";
	if (/alquilas|propietari|arrendador/.test(t)) return "llave";
	return "persona";
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse and validate one ficha file. Throws with the file name on any error. */
export function parseFicha(source: string, fileName = "ficha"): Ficha {
	const m = source.match(FRONTMATTER);
	if (!m) throw new Error(`[fichas] ${fileName}: falta el frontmatter`);
	let raw: unknown;
	try {
		// JSON_SCHEMA keeps dates as strings ("2026-10-01", not a Date).
		raw = yaml.load(m[1]!, { schema: yaml.JSON_SCHEMA });
	} catch (e) {
		throw new Error(`[fichas] ${fileName}: YAML inválido: ${String(e)}`);
	}
	const parsed = fichaFrontmatter.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`[fichas] ${fileName}: frontmatter inválido: ${parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
		);
	}
	const body = m[2]!.trim();
	if (!body) throw new Error(`[fichas] ${fileName}: cuerpo vacío`);
	let sections: FichaSection[];
	try {
		sections = parseSections(body);
	} catch (e) {
		throw new Error(`[fichas] ${fileName}: ${(e as Error).message}`);
	}
	if (
		parsed.data.hitos.length > 0 &&
		!sections.some((s) => s.kind === "dates")
	) {
		throw new Error(
			`[fichas] ${fileName}: hay hitos pero no una sección «## Desde cuándo…» donde mostrarlos`,
		);
	}
	return { ...parsed.data, body, sections };
}

// ── Body rendering ────────────────────────────────────────────────────────

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

/** Accessible text for an empty table corner header ("|  | Antes | Ahora |"). */
const EMPTY_CORNER_LABEL = "Situación";

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function htmlToken(content: string): Token {
	const t = new md.core.State("", md, {}).Token;
	const tok = new t("html_inline", "", 0);
	tok.content = content;
	return tok;
}

/**
 * Adjust the token stream for the page:
 * - headings one level down (the page's h1 is the law title, the ficha
 *   titular is an h2, so the body's "##" become h3);
 * - tables: column headers get scope="col" (an empty corner gets hidden
 *   text), the first cell of each body row becomes a row header, every cell
 *   gets data-label (the mobile layout stacks rows as cards), and the table
 *   gets a visually hidden caption from the heading above it;
 * - paragraphs that start with "Fuente:" are styled as source notes.
 */
function transformTokens(tokens: Token[]): void {
	let lastHeading = "";
	let colLabels: string[] = [];
	let inHead = false;
	let col = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		switch (t.type) {
			case "heading_open": {
				const level = Number(t.tag.slice(1));
				t.tag = `h${Math.min(level + 1, 6)}`;
				t.attrJoin("class", "ficha-heading");
				lastHeading = tokens[i + 1]?.content ?? "";
				break;
			}
			case "heading_close":
				t.tag = `h${Math.min(Number(t.tag.slice(1)) + 1, 6)}`;
				break;
			case "table_open":
				t.attrJoin("class", "ficha-table");
				t.meta = { caption: lastHeading };
				colLabels = [];
				break;
			case "thead_open":
				inHead = true;
				break;
			case "thead_close":
				inHead = false;
				break;
			case "tr_open":
				col = 0;
				break;
			case "th_open":
			case "td_open": {
				const inline = tokens[i + 1];
				if (inHead) {
					t.attrSet("scope", "col");
					const label = inline?.content.trim() ?? "";
					colLabels.push(label || EMPTY_CORNER_LABEL);
					if (!label && inline) {
						inline.children = [
							htmlToken(
								`<span class="sr-only">${escapeHtml(EMPTY_CORNER_LABEL)}</span>`,
							),
						];
					}
				} else if (col === 0) {
					t.tag = "th";
					t.type = "th_open";
					t.attrSet("scope", "row");
					// The matching close tag is the next td_close at this level.
					for (let j = i + 1; j < tokens.length; j++) {
						if (tokens[j]!.type === "td_close") {
							tokens[j]!.tag = "th";
							tokens[j]!.type = "th_close";
							break;
						}
					}
				} else {
					const label = colLabels[col];
					if (label) t.attrSet("data-label", label);
				}
				col++;
				break;
			}
			case "paragraph_open":
				if (/^Fuente:/.test(tokens[i + 1]?.content ?? "")) {
					t.attrJoin("class", "ficha-source");
				}
				break;
		}
	}
}

md.renderer.rules.table_open = (tokens, idx, options, _env, self) => {
	const caption = tokens[idx]!.meta?.caption as string | undefined;
	const open = self.renderToken(tokens, idx, options);
	return caption
		? `<div class="ficha-table-wrap">${open}<caption class="sr-only">${escapeHtml(caption)}</caption>\n`
		: `<div class="ficha-table-wrap">${open}`;
};
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
	`${self.renderToken(tokens, idx, options)}</div>\n`;

/**
 * Legal references in brackets ("[art. 10.1 LAU]", "[DT, ap. 2]") are
 * rendered as discreet secondary text (mono, muted, without the brackets),
 * not as something that looks like a broken link. Runs on the rendered HTML,
 * where real links have already been turned into <a> elements, so only
 * literal brackets remain.
 */
export function markReferences(html: string): string {
	return html
		.replace(/\[([^[\]<>\n]{1,60})\]/g, '<span class="ficha-ref">$1</span>')
		.replace(/<\/span> <span class="ficha-ref">/g, " · ");
}

/** Plain Markdown to HTML (headings one level down, tables, references). */
export function renderFichaBody(body: string): string {
	return renderBlockTokens(md.parse(body, {}));
}

function renderBlockTokens(tokens: Token[]): string {
	transformTokens(tokens);
	return markReferences(md.renderer.render(tokens, md.options, {})).trim();
}

function renderInline(tokens: Token[]): string {
	return markReferences(
		md.renderer.renderInline(tokens, md.options, {}),
	).trim();
}

// ── Body → sections ───────────────────────────────────────────────────────

interface Block {
	type: string;
	open: Token;
	/** Tokens between open and close (empty for self-contained tokens). */
	inner: Token[];
}

/** Split a token run into its top-level blocks (by nesting level). */
function blocks(tokens: Token[]): Block[] {
	const out: Block[] = [];
	if (tokens.length === 0) return out;
	const base = tokens[0]!.level;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.nesting !== 1) {
			out.push({ type: t.type, open: t, inner: [] });
			continue;
		}
		let j = i + 1;
		while (
			j < tokens.length &&
			!(tokens[j]!.level === base && tokens[j]!.nesting === -1)
		) {
			j++;
		}
		out.push({
			type: t.type.replace(/_open$/, ""),
			open: t,
			inner: tokens.slice(i + 1, j),
		});
		i = j;
	}
	return out;
}

const blockName = (b: Block) =>
	b.type === "heading" ? `encabezado ${b.open.markup}` : b.type;

function inlineOf(b: Block): Token {
	const inline = b.inner.find((t) => t.type === "inline");
	if (!inline) throw new Error(`${blockName(b)} sin texto`);
	return inline;
}

/** `**Título.** {.duda} Texto [ref]` → title, flags and the rest as HTML. */
function parseItemInline(inline: Token): Omit<FichaItem, "subitems"> {
	const children = [...(inline.children ?? [])];
	// markdown-it opens "**…" with an empty text token.
	while (children[0]?.type === "text" && children[0].content === "") {
		children.shift();
	}
	let title: string | undefined;
	const flags: FichaItemFlag[] = [];
	if (children[0]?.type === "strong_open") {
		const close = children.findIndex((c) => c.type === "strong_close");
		title = children
			.slice(1, close)
			.map((c) => c.content)
			.join("")
			.trim()
			.replace(/\.$/, "");
		children.splice(0, close + 1);
		const first = children[0];
		if (first?.type === "text") {
			let rest = first.content.replace(/^\s+/, "");
			for (
				let m = rest.match(/^\{\.([a-z-]+)\}\s*/);
				m;
				m = rest.match(/^\{\.([a-z-]+)\}\s*/)
			) {
				const flag = m[1] as FichaItemFlag;
				if (!FICHA_ITEM_FLAGS.includes(flag)) {
					throw new Error(
						`marca desconocida {.${m[1]}} en «${title}» (válidas: ${FICHA_ITEM_FLAGS.map((f) => `{.${f}}`).join(", ")})`,
					);
				}
				flags.push(flag);
				rest = rest.slice(m[0].length);
			}
			first.content = rest;
		}
		if (!title) throw new Error("título en negrita vacío");
	}
	const html = renderInline(children);
	if (!html) throw new Error(`«${title ?? ""}» sin texto`);
	return { title, html, flags };
}

function parseList(b: Block, where: string): FichaItem[] {
	if (b.type !== "bullet_list" && b.type !== "ordered_list") {
		throw new Error(`${where}: se esperaba una lista y hay ${blockName(b)}`);
	}
	return blocks(b.inner).map((li) => {
		const parts = blocks(li.inner);
		const [para, ...rest] = parts;
		if (para?.type !== "paragraph") {
			throw new Error(`${where}: cada elemento de la lista empieza con texto`);
		}
		const item: FichaItem = {
			...parseItemInline(inlineOf(para)),
			subitems: [],
		};
		for (const p of rest) {
			if (p.type !== "bullet_list" && p.type !== "ordered_list") {
				throw new Error(
					`${where}: dentro de un elemento solo cabe una sublista (hay ${blockName(p)})`,
				);
			}
			for (const sub of blocks(p.inner)) {
				const subParts = blocks(sub.inner);
				if (subParts.length !== 1 || subParts[0]!.type !== "paragraph") {
					throw new Error(`${where}: las sublistas tienen un solo nivel`);
				}
				item.subitems.push(renderInline(inlineOf(subParts[0]!).children ?? []));
			}
		}
		return item;
	});
}

function parseParagraphs(bs: Block[], where: string): string[] {
	return bs.map((b) => {
		if (b.type !== "paragraph") {
			throw new Error(`${where}: solo admite párrafos (hay ${blockName(b)})`);
		}
		return renderInline(inlineOf(b).children ?? []);
	});
}

function parseTable(b: Block, where: string) {
	const rows: Token[][][] = [];
	let head: Token[][] = [];
	for (const part of blocks(b.inner)) {
		for (const tr of blocks(part.inner)) {
			const cells = blocks(tr.inner).map((c) => c.inner);
			if (part.type === "thead") head = cells;
			else rows.push(cells);
		}
	}
	const text = (cell: Token[]) =>
		renderInline(cell.find((t) => t.type === "inline")?.children ?? []);
	const [corner, ...columns] = head.map(text);
	if (columns.length === 0) {
		throw new Error(
			`${where}: la tabla necesita columnas (| | Antes | Ahora |)`,
		);
	}
	return {
		corner: corner || EMPTY_CORNER_LABEL,
		columns,
		rows: rows.map((cells) => {
			if (cells.length !== columns.length + 1) {
				throw new Error(
					`${where}: una fila no tiene ${columns.length + 1} celdas`,
				);
			}
			const [topic, ...rest] = cells.map(text);
			return { topic: topic!, cells: rest };
		}),
	};
}

/**
 * Parse the body into sections, one per "##" heading. Known headings
 * (KNOWN_SECTIONS) get a structure and their own layout and must follow it;
 * any other heading is kept as plain Markdown. Throws on content before the
 * first "##", a repeated known section or an unexpected structure.
 */
export function parseSections(body: string): FichaSection[] {
	const tokens = md.parse(body, {});
	const raw: { title: string; tokens: Token[] }[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.type === "heading_open" && t.tag === "h2") {
			raw.push({ title: tokens[i + 1]?.content.trim() ?? "", tokens: [] });
			i += 2;
			continue;
		}
		const current = raw[raw.length - 1];
		if (!current) throw new Error("hay texto antes del primer «##»");
		current.tokens.push(t);
	}

	const seen = new Set<string>();
	return raw.map(({ title, tokens: ts }): FichaSection => {
		const known = KNOWN_SECTIONS.find((k) => k.match.test(title.toLowerCase()));
		const where = `«## ${title}»`;
		const id = known?.id ?? `ficha-${slug(title)}`;
		if (seen.has(id)) throw new Error(`${where} repetida`);
		seen.add(id);
		const base: SectionBase = {
			id,
			title,
			tocLabel:
				!known || known.toc === "heading"
					? title
					: known.toc === "none"
						? null
						: known.toc.label,
			kicker: known?.kicker ?? null,
		};
		const bs = blocks(ts);
		if (!known) return { ...base, kind: "prose", html: renderBlockTokens(ts) };
		switch (known.kind) {
			case "summary":
			case "dates": {
				if (bs.length !== 1) {
					throw new Error(`${where}: debe ser una sola lista`);
				}
				return { ...base, kind: known.kind, items: parseList(bs[0]!, where) };
			}
			case "changes": {
				const [table, ...notes] = bs;
				if (table?.type !== "table") {
					throw new Error(`${where}: debe empezar con una tabla`);
				}
				return {
					...base,
					kind: "changes",
					...parseTable(table, where),
					notes: parseParagraphs(notes, where),
				};
			}
			case "audiences": {
				const groups: Extract<FichaSection, { kind: "audiences" }>["groups"] =
					[];
				for (const b of bs) {
					if (b.type === "heading" && b.open.tag === "h3") {
						const groupTitle = inlineOf(b).content.trim();
						groups.push({
							title: groupTitle,
							icon: audienceIcon(groupTitle),
							items: [],
						});
						continue;
					}
					const group = groups[groups.length - 1];
					if (!group) {
						throw new Error(
							`${where}: cada grupo empieza con «### Si…» y sigue con una lista`,
						);
					}
					group.items.push(...parseList(b, where));
				}
				if (groups.length === 0 || groups.some((g) => g.items.length === 0)) {
					throw new Error(`${where}: cada «###» necesita una lista`);
				}
				return { ...base, kind: "audiences", groups };
			}
			default:
				return {
					...base,
					kind: known.kind,
					paragraphs: parseParagraphs(bs, where),
				};
		}
	});
}

// ── Loading ───────────────────────────────────────────────────────────────

/** Where the ficha files live: FICHAS_DIR, or src/data/fichas from the web package. */
export function fichasDir(): string | null {
	const candidates = [
		process.env.FICHAS_DIR,
		resolve(process.cwd(), "src/data/fichas"),
		resolve(process.cwd(), "packages/web/src/data/fichas"),
	].filter((p): p is string => Boolean(p));
	return candidates.find((p) => existsSync(p)) ?? null;
}

/** Parse a set of ficha sources (file name → content) into an id → ficha map. */
export function parseFichas(
	sources: Record<string, string>,
): Map<string, Ficha> {
	const out = new Map<string, Ficha>();
	for (const [file, source] of Object.entries(sources).sort()) {
		const ficha = parseFicha(source, file);
		const expected = file.replace(/\.md$/, "").split("/").pop();
		if (expected !== ficha.identificador) {
			throw new Error(
				`[fichas] ${file}: el nombre del archivo no coincide con identificador ${ficha.identificador}`,
			);
		}
		if (out.has(ficha.identificador)) {
			throw new Error(`[fichas] ${ficha.identificador} duplicada`);
		}
		out.set(ficha.identificador, ficha);
	}
	return out;
}

let _fichas: Map<string, Ficha> | undefined;

/** All fichas (read once per build). */
export function loadFichas(): Map<string, Ficha> {
	if (_fichas) return _fichas;
	const dir = fichasDir();
	const sources: Record<string, string> = {};
	if (dir) {
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".md")) sources[f] = readFileSync(join(dir, f), "utf-8");
		}
	}
	_fichas = parseFichas(sources);
	return _fichas;
}

/** Test hook: replace (or reset with undefined) the loaded fichas. */
export function setFichasForTesting(fichas: Map<string, Ficha> | undefined) {
	_fichas = fichas;
}

export function getFicha(id: string): Ficha | undefined {
	return loadFichas().get(id);
}

export function hasFicha(id: string): boolean {
	return loadFichas().has(id);
}

// ── SEO ──────────────────────────────────────────────────────────────────

/** Full `<title>` of a page with a ficha (≤ SEO_TITLE_MAX, with the site suffix). */
export function fichaSeoTitle(ficha: Pick<Ficha, "seo_titulo">): string {
	return composeSeoTitle(ficha.seo_titulo, SEO_TITLE_MAX);
}

/** The later of two ISO dates (either may be missing). */
export function laterDate(a?: string, b?: string): string | undefined {
	if (!a) return b;
	if (!b) return a;
	return a > b ? a : b;
}

// ── Notices on modified laws ──────────────────────────────────────────────

export interface ModificationNotice {
	/** Id of the law whose ficha explains the change. */
	fichaId: string;
	/** Visible text (without the link). */
	text: string;
	/** Link text and target. */
	linkText: string;
	href: string;
}

/** "10" → "El artículo 10", ["10","11"] → "Los artículos 10 y 11". */
function articlesPhrase(articulos: string[]): {
	subject: string;
	plural: boolean;
} {
	if (articulos.length === 1) {
		return { subject: `El artículo ${articulos[0]}`, plural: false };
	}
	const head = articulos.slice(0, -1).join(", ");
	return {
		subject: `Los artículos ${head} y ${articulos[articulos.length - 1]}`,
		plural: true,
	};
}

export function noticeText(
	ficha: Pick<Ficha, "nombre_corto" | "en_vigor">,
	mod: FichaFrontmatter["modifica"][number],
): string {
	const { subject, plural } = articlesPhrase(mod.articulos);
	const first = `${subject} de esta ley ${plural ? "han sido modificados" : "ha sido modificado"} por el ${ficha.nombre_corto} (en vigor desde el ${formatDate(ficha.en_vigor)}).`;
	const second = mod.boe_consolidado
		? "El texto consolidado del BOE ya incluye el cambio, pero los resúmenes de esta página pueden no reflejarlo todavía."
		: "Es posible que el texto del BOE y los resúmenes de esta página todavía no lo reflejen.";
	return `${first} ${second}`;
}

/** Notices for a law, derived from the `modifica` lists of every ficha. */
export function noticesFor(
	lawId: string,
	fichas: Map<string, Ficha> = loadFichas(),
): ModificationNotice[] {
	const out: ModificationNotice[] = [];
	for (const ficha of fichas.values()) {
		if (ficha.identificador === lawId) continue;
		for (const mod of ficha.modifica) {
			if (mod.identificador !== lawId) continue;
			out.push({
				fichaId: ficha.identificador,
				text: noticeText(ficha, mod),
				linkText: `Qué cambia con el ${ficha.nombre_corto}`,
				href: `/leyes/${ficha.identificador}/`,
			});
		}
	}
	return out;
}

/**
 * Own-content parts per law page for the lastmod hash (page-lastmod.ts): the
 * ficha itself on its law, and each notice on the laws it modifies. Laws
 * without either are absent, so their hashes do not change.
 */
export function fichaContentParts(
	fichas: Map<string, Ficha> = loadFichas(),
): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	const add = (id: string, part: string) => {
		const list = out[id] ?? [];
		list.push(part);
		out[id] = list;
	};
	for (const ficha of fichas.values()) {
		const { sections: _sections, body, ...meta } = ficha;
		add(ficha.identificador, `ficha\u0000${JSON.stringify(meta)}\u0000${body}`);
		for (const mod of ficha.modifica) {
			if (mod.identificador === ficha.identificador) continue;
			add(
				mod.identificador,
				`aviso\u0000${ficha.identificador}\u0000${noticeText(ficha, mod)}`,
			);
		}
	}
	return out;
}
