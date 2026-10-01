/**
 * Structural chunking of a law for the multi-step ficha pipeline.
 *
 * Input: the law's Markdown (src-<id>.md, articles and dispositions under
 * `#####` headings, annexes under `## ANEXO`) and the previous wording of the
 * articles it modifies (prev-<id>.md, one `### Redacción anterior: …` block
 * per article). Output: pieces, each one article, disposition, annex or
 * amendment item ("Uno. Se modifica el artículo 13…") with the previous
 * wording of the provisions it rewrites attached. Short consecutive pieces are
 * grouped so a law does not become dozens of tiny calls.
 */

export interface PrevBlock {
	/** "Ley Orgánica 10/1995, de 23 de noviembre, del Código Penal" */
	law: string;
	/** BOE id of the modified law, when present. */
	lawId: string;
	/** "Artículo 544 bis", "Disposición adicional cuarta", "TÍTULO IV"… */
	label: string;
	header: string;
	text: string;
}

export interface Piece {
	id: string;
	kind: "preambulo" | "dispositivo" | "anexo";
	/** Section path (título, capítulo) and heading of the article. */
	context: string;
	/** Headings of the units in this piece, for logs. */
	units: string[];
	text: string;
	prev: PrevBlock[];
}

const GROUP_TARGET = 9000;
const MAX_TEXT = 30000;

export function parsePrev(md: string): PrevBlock[] {
	const blocks: PrevBlock[] = [];
	const parts = md.split(/^(?=### Redacción anterior: )/m);
	for (const part of parts) {
		const m = part.match(
			/^### Redacción anterior: (.*?) \((BOE-[A-Z]-[\d-]+)\), (.*?) \[(?:sic\] \[)?bloque [^\]]*\][^\n]*\n/,
		);
		if (!m) continue;
		blocks.push({
			law: m[1] ?? "",
			lawId: m[2] ?? "",
			label: (m[3] ?? "").replace(/\s*\[sic\]\s*$/, "").trim(),
			header: part.split("\n")[0] ?? "",
			text: part.slice(m[0].length).trim(),
		});
	}
	return blocks;
}

const strip = (s: string) =>
	s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Identifiers of a law title that a modifying provision would cite. */
function lawKeys(title: string): string[] {
	const keys = new Set<string>();
	for (const m of title.matchAll(/\b[A-Z]{0,4}\/?\d+\/\d{4}\b/g))
		keys.add(m[0]);
	if (!keys.size) {
		const d = title.match(/de \d+ de [a-záéíóú]+ de \d{4}/i);
		if (d) keys.add(d[0]);
	}
	return [...keys].map(strip);
}

const SUFFIX = "(?:bis|ter|quater|quinquies|sexies|septies|octies|nonies)";

/** Regex that finds a reference to `label` ("Artículo 22") in an instruction. */
function labelRegex(label: string): RegExp {
	const l = strip(label).replace(/\.$/, "").trim();
	const m = l.match(
		/^(articulo|disposicion (?:adicional|transitoria|final|derogatoria)|titulo|capitulo|anexo|seccion)\s+(.+)$/,
	);
	if (!m) {
		// Bare numbered units ("3. Precio y gastos del transporte").
		const n = l.match(/^(\d+)/);
		return n ? new RegExp(`\\b${n[1]}\\b(?![.,]\\d)`) : new RegExp(escapeRe(l));
	}
	const kind = (m[1] ?? "")
		.split(" ")
		.map((w) => `${escapeRe(w)}(?:es|s)?`)
		.join("\\s+");
	const id = (m[2] ?? "").trim();
	const tail = new RegExp(`\\s${SUFFIX}$`).test(id) ? "" : `(?!\\s+${SUFFIX})`;
	return new RegExp(`${kind}\\b[^\\n]{0,80}?\\b${escapeRe(id)}\\b${tail}`);
}

const ORD_UNITS =
	"uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintidós|veintitrés|veinticuatro|veinticinco|veintiséis|veintisiete|veintiocho|veintinueve";
const ORD_TENS = "treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa";
const ITEM_RE = new RegExp(
	`^(?:\\*\\*)?(?:${ORD_UNITS}|(?:${ORD_TENS})(?: y (?:uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve))?|cien)\\.(?:\\*\\*)?\\s`,
	"i",
);

interface Unit {
	kind: Piece["kind"];
	context: string;
	heading: string;
	/** Text of the parent provision before its first amendment item. */
	intro: string;
	text: string;
}

/** Split the law into preamble, provisions (and their amendment items), annexes. */
function units(src: string): Unit[] {
	const lines = src.split("\n");
	const out: Unit[] = [];
	let section: string[] = [];
	let inAnnex = false;
	let cur: { kind: Piece["kind"]; heading: string; lines: string[] } = {
		kind: "preambulo",
		heading: "Preámbulo / exposición de motivos",
		lines: [],
	};
	let curSection = "";
	const flush = () => {
		const text = cur.lines.join("\n").trim();
		// Separators ("---") and blank remainders are not units.
		if (text.replace(/[-*_#\s]/g, "").length < 20) return;
		if (cur.kind !== "dispositivo") {
			out.push({
				kind: cur.kind,
				context: curSection,
				heading: cur.heading,
				intro: "",
				text,
			});
			return;
		}
		// Amendment items: "Uno. Se modifica…", "Dos. …" at the start of a line.
		const starts: number[] = [];
		cur.lines.forEach((l, i) => {
			if (ITEM_RE.test(l)) starts.push(i);
		});
		if (starts.length < 2) {
			out.push({
				kind: "dispositivo",
				context: curSection,
				heading: cur.heading,
				intro: "",
				text,
			});
			return;
		}
		const intro = cur.lines.slice(0, starts[0]).join("\n").trim();
		starts.forEach((s, k) => {
			const body = cur.lines
				.slice(s, starts[k + 1] ?? cur.lines.length)
				.join("\n")
				.trim();
			out.push({
				kind: "dispositivo",
				context: curSection,
				heading: cur.heading,
				intro,
				text: body,
			});
		});
	};
	for (const line of lines) {
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h && /^ANEXO\b/i.test((h[2] ?? "").replace(/\*/g, "").trim())) {
			flush();
			inAnnex = true;
			cur = { kind: "anexo", heading: (h[2] ?? "").trim(), lines: [] };
			curSection = "";
			continue;
		}
		if (h && !inAnnex) {
			const title = (h[2] ?? "").replace(/\*\*/g, "").trim();
			if ((h[1] ?? "").length === 5) {
				flush();
				cur = { kind: "dispositivo", heading: title, lines: [] };
				curSection = section.join(" › ");
				continue;
			}
			if (/^(T[ÍI]TULO|CAP[ÍI]TULO|SECCI[ÓO]N|LIBRO)\b/i.test(title)) {
				// Structural heading: context for the provisions that follow.
				flush();
				if (/^(T[ÍI]TULO|LIBRO)/i.test(title)) section = [title];
				else if (/^CAP/i.test(title))
					section = [
						...section.filter((s) => /^(T[ÍI]TULO|LIBRO)/i.test(s)),
						title,
					];
				else section = [...section.filter((s) => !/^SECCI/i.test(s)), title];
				cur = { kind: cur.kind, heading: cur.heading, lines: [] };
				continue;
			}
		}
		cur.lines.push(line);
	}
	flush();
	return out;
}

/** Instruction text of a unit: heading, intro and its non-quoted lines. */
function instruction(u: Unit): string {
	const own = u.text
		.split("\n")
		.filter((l) => !l.startsWith(">"))
		.join("\n");
	const firstQuoted =
		u.text
			.split("\n")
			.find((l) => l.startsWith(">"))
			?.slice(0, 200) ?? "";
	return strip(`${u.heading}\n${u.intro}\n${own}\n${firstQuoted}`);
}

function splitLong(text: string): string[] {
	if (text.length <= MAX_TEXT) return [text];
	const parts: string[] = [];
	let acc = "";
	for (const para of text.split(/\n(?=\S)/)) {
		if (acc && acc.length + para.length > MAX_TEXT) {
			parts.push(acc);
			acc = "";
		}
		acc += `${acc ? "\n" : ""}${para}`;
	}
	if (acc) parts.push(acc);
	return parts;
}

export interface ChunkResult {
	pieces: Piece[];
	/** Previous-wording blocks no provision could be matched with. */
	unmatchedPrev: string[];
}

export function chunkLaw(src: string, prevMd: string): ChunkResult {
	const prev = parsePrev(prevMd);
	const us = units(src);
	const attached = us.map(() => [] as PrevBlock[]);
	const used = new Set<number>();
	const keysOf = prev.map((p) => lawKeys(p.law));

	// 1. Exact: the unit names the modified law and the provision.
	us.forEach((u, i) => {
		if (u.kind !== "dispositivo") return;
		const ins = instruction(u);
		const lawCtx = strip(`${u.heading}\n${u.intro}\n${ins}`);
		prev.forEach((p, j) => {
			if (used.has(j)) return;
			const keys = keysOf[j] ?? [];
			if (!keys.some((k) => lawCtx.includes(k))) return;
			if (labelRegex(p.label).test(ins)) {
				attached[i]?.push(p);
				used.add(j);
			}
		});
	});
	// 2. Fallback: first provision that mentions the modified law anywhere.
	const unmatchedPrev: string[] = [];
	prev.forEach((p, j) => {
		if (used.has(j)) return;
		const keys = keysOf[j] ?? [];
		const i = us.findIndex(
			(u) =>
				u.kind === "dispositivo" &&
				keys.some((k) =>
					strip(`${u.heading}\n${u.intro}\n${u.text}`).includes(k),
				),
		);
		if (i >= 0) {
			attached[i]?.push(p);
			used.add(j);
		} else unmatchedPrev.push(p.header);
	});

	// 3. Build pieces; group short consecutive units of the same provision kind.
	const pieces: Piece[] = [];
	const size = (t: string, ps: PrevBlock[]) =>
		t.length + ps.reduce((n, p) => n + p.text.length, 0);
	let open: Piece | null = null;
	us.forEach((u, i) => {
		const ps = attached[i] ?? [];
		const head = u.intro
			? `${u.heading}\n${u.intro.split("\n")[0]}`
			: u.heading;
		const label = `${u.context ? `${u.context} › ` : ""}${head}`;
		// The preamble is context only: one call, however long.
		const texts = u.kind === "preambulo" ? [u.text] : splitLong(u.text);
		texts.forEach((t, k) => {
			const block = `[${u.heading}${texts.length > 1 ? ` (parte ${k + 1}/${texts.length})` : ""}]\n${u.intro && k === 0 ? `${u.intro}\n\n` : ""}${t}`;
			const myPrev = k === 0 ? ps : [];
			const canJoin =
				open &&
				open.kind === u.kind &&
				u.kind !== "preambulo" &&
				size(open.text, open.prev) + size(block, myPrev) <= GROUP_TARGET;
			if (open && canJoin) {
				open.text += `\n\n${block}`;
				open.prev.push(...myPrev);
				open.units.push(head.split("\n")[0] ?? "");
				if (!open.context.includes(label)) open.context += `\n${label}`;
				return;
			}
			open = {
				id: `p${String(pieces.length + 1).padStart(2, "0")}`,
				kind: u.kind,
				context: label,
				units: [head.split("\n")[0] ?? ""],
				text: block,
				prev: [...myPrev],
			};
			pieces.push(open);
		});
	});
	return { pieces, unmatchedPrev };
}

/** Start of a structural unit: heading, quoted article, amendment item, piece marker. */
const UNIT_START = new RegExp(
	`^(?:#{1,6}\\s|>\\s*«?\\s*(?:Art[íi]culo|Disposici[óo]n|ANEXO)\\b|\\[|${ITEM_RE.source.slice(1)})`,
	"i",
);

/**
 * Passage of `source` that contains `quote` (normalized), for verification:
 * the matching paragraph(s) plus the opening of the unit they belong to (an
 * article's lead sentence often holds the penalty or the subject that the
 * quoted paragraph only lists).
 */
export function locate(
	source: string,
	quote: string,
	max = 1500,
): string | null {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.replace(/[«»“”"'‘’>*]/g, "")
			.replace(/[–—]/g, "-")
			.replace(/\s+/g, " ")
			.trim();
	const q = norm(quote).replace(/^[.…\s]+|[.…;,:\s]+$/g, "");
	if (q.length < 8) return null;
	const paras = source.split(/\n\s*\n/);
	for (let i = 0; i < paras.length; i++) {
		const n = norm(paras[i] ?? "");
		const span = n.includes(q)
			? 1
			: `${n} ${norm(paras[i + 1] ?? "")}`.includes(q)
				? 2
				: 0;
		if (!span) continue;
		const hit = clip(
			paras
				.slice(i, i + span)
				.map((p) => p.trim())
				.join("\n"),
			quote,
			max,
		);
		let s = i;
		while (s > 0 && s > i - 40 && !UNIT_START.test((paras[s] ?? "").trim()))
			s--;
		// Unit opening (two paragraphs) and the paragraph right before the hit.
		const lead = [...new Set([s, s + 1, i - 1])].filter((j) => j >= s && j < i);
		const out: string[] = [];
		let last = s - 1;
		for (const j of lead) {
			if (j > last + 1) out.push("[…]");
			const t = (paras[j] ?? "").trim();
			out.push(t.length > 700 ? `${t.slice(0, 700)}…` : t);
			last = j;
		}
		if (i > last + 1) out.push("[…]");
		out.push(hit);
		return out.filter(Boolean).join("\n\n");
	}
	return null;
}

function clip(text: string, quote: string, max: number): string {
	if (text.length <= max) return text;
	const at = Math.max(0, text.indexOf(quote.slice(0, 30)));
	const start = Math.max(0, at - Math.floor(max / 3));
	return `${start ? "…" : ""}${text.slice(start, start + max)}…`;
}
