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

const fichaFrontmatter = z.object({
	identificador: z.string().regex(NORM_ID),
	/** Short name used in notices: "Real Decreto-ley 27/2026". */
	nombre_corto: z.string().min(1),
	etiquetas: z.array(z.string().min(1)).min(1),
	titular: z.string().min(1),
	subtitulo: z.string().min(1),
	estado: z.array(z.string().min(1)).default([]),
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
	/** Body rendered to HTML (headings shifted one level down). */
	html: string;
	/** Raw body Markdown (hashed for lastmod). */
	body: string;
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
	return { ...parsed.data, body, html: renderFichaBody(body) };
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
 * rendered as discreet secondary text, not as something that looks like a
 * broken link. Runs on the rendered HTML, where real links have already been
 * turned into <a> elements, so only literal brackets remain.
 */
export function markReferences(html: string): string {
	return html.replace(
		/\[([^[\]<>\n]{1,60})\]/g,
		'<span class="ficha-ref">[$1]</span>',
	);
}

export function renderFichaBody(body: string): string {
	const tokens = md.parse(body, {});
	transformTokens(tokens);
	return markReferences(md.renderer.render(tokens, md.options, {}));
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
		const { html: _html, body, ...meta } = ficha;
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
