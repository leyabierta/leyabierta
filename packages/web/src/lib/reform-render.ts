// Server-side rendering for the reforma detail page content, shared by the
// standalone Cloudflare Worker (src/worker/index.ts). Pure TS — no Astro, no
// fs, no browser globals — so it can run inside workerd without a bundler
// adapter. Ported from the (removed) SSR version of
// src/pages/cambios/reforma/index.astro; see git history on feat/reform-ssr
// before the restore-from-main commit for the original Astro source.

import { escapeHtml } from "./escape.ts";

// ── API response shapes (mirrors packages/api/src/routes/reforms.ts, omnibus.ts, laws.ts) ──
export interface ReformInfo {
	date: string;
	reform_type: string | null;
	headline: string | null;
	summary: string | null;
	importance: string | null;
}
export interface LawInfo {
	id: string;
	title: string;
	short_title?: string | null;
	rank: string;
	status: string;
	source_url: string;
	last_reform_date: string | null;
}
export interface AffectedBlock {
	block_id: string;
	block_type: string;
	title: string;
	before_text: string | null;
	after_text: string;
}
export interface ReformDetailResponse {
	law: LawInfo;
	reform: ReformInfo;
	affected_blocks: AffectedBlock[];
	prev_reform_date: string | null;
	next_reform_date: string | null;
	source_url: string;
}
export interface OmnibusTopic {
	topic_label: string;
	block_ids: string[];
}
export interface OmnibusResponse {
	topics: OmnibusTopic[];
}

// ── Citizen-facing label maps (ported from the former client-side <script>) ──
export const RANK_LABELS: Record<string, string> = {
	constitucion: "Constitución",
	ley_organica: "Ley Orgánica",
	ley: "Ley",
	real_decreto_ley: "Decreto urgente",
	real_decreto_legislativo: "Decreto legislativo",
	real_decreto: "Real Decreto",
	orden: "Orden",
	resolucion: "Resolución",
	acuerdo_internacional: "Acuerdo internacional",
	circular: "Circular",
	instruccion: "Instrucción",
	decreto: "Decreto",
	reglamento: "Reglamento",
	acuerdo: "Acuerdo",
};
export const STATUS_LABELS: Record<string, string> = {
	vigente: "En vigor",
	derogada: "Ya no está en vigor",
	parcialmente_derogada: "Parcialmente en vigor",
};
export const TYPE_LABELS: Record<string, string> = {
	new_law: "Ley nueva",
	modification: "Modificación",
	correction: "Corrección",
	derogation: "Derogación",
};

// ── Diff helpers ──
export type DiffOp<T> = { t: "eq" | "del" | "add"; v: T };

export function seqDiff<T>(
	a: T[],
	b: T[],
	eq: (x: T, y: T) => boolean,
): DiffOp<T>[] {
	const n = a.length;
	const m = b.length;
	// For large sequences use a size cap to avoid O(n*m) blowup
	if (n * m > 200_000) {
		const ops: DiffOp<T>[] = [];
		for (const x of a) ops.push({ t: "del", v: x });
		for (const y of b) ops.push({ t: "add", v: y });
		return ops;
	}
	const dp: Int32Array[] = [];
	for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
	for (let i = n - 1; i >= 0; i--) {
		const row = dp[i] as Int32Array;
		const nextRow = dp[i + 1] as Int32Array;
		for (let j = m - 1; j >= 0; j--) {
			row[j] = eq(a[i] as T, b[j] as T)
				? (nextRow[j + 1] as number) + 1
				: Math.max(nextRow[j] as number, row[j + 1] as number);
		}
	}
	const result: DiffOp<T>[] = [];
	let pi = 0;
	let pj = 0;
	while (pi < n && pj < m) {
		if (eq(a[pi] as T, b[pj] as T)) {
			result.push({ t: "eq", v: a[pi] as T });
			pi++;
			pj++;
		} else if (
			(dp[pi + 1] as Int32Array)[pj]! >= (dp[pi] as Int32Array)[pj + 1]!
		) {
			result.push({ t: "del", v: a[pi] as T });
			pi++;
		} else {
			result.push({ t: "add", v: b[pj] as T });
			pj++;
		}
	}
	while (pi < n) result.push({ t: "del", v: a[pi++] as T });
	while (pj < m) result.push({ t: "add", v: b[pj++] as T });
	return result;
}

export function wordDiff(before: string, after: string): DiffOp<string>[] {
	const a = before.split(/(\s+)/);
	const b = after.split(/(\s+)/);
	return seqDiff(a, b, (x, y) => x === y);
}

/** Exact escaping used by every render function below — ported 1:1 from the
 *  former SSR Astro page's `esc()`. Backed by the shared `escapeHtml` helper
 *  (identical replacement set: & < > "). */
export function esc(s: unknown): string {
	return escapeHtml(String(s));
}

const MONTHS = [
	"ene",
	"feb",
	"mar",
	"abr",
	"may",
	"jun",
	"jul",
	"ago",
	"sep",
	"oct",
	"nov",
	"dic",
];
export function formatDate(d: string): string {
	const dt = new Date(`${d}T00:00:00`);
	return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
}

export function buildWordDiffHtml(
	beforePara: string,
	afterPara: string,
): string {
	const ops = wordDiff(beforePara, afterPara);
	let beforeHtml = '<span class="diff-label">Antes</span>';
	let afterHtml = '<span class="diff-label">Ahora</span>';
	for (const op of ops) {
		const v = esc(op.v);
		if (op.t === "eq") {
			beforeHtml += v;
			afterHtml += v;
		} else if (op.t === "del") {
			beforeHtml += `<span class="diff-word-removed">${v}</span>`;
		} else {
			afterHtml += `<span class="diff-word-added">${v}</span>`;
		}
	}
	return `<div class="diff-mod-pair"><div class="diff-para diff-para-removed">${beforeHtml}</div><div class="diff-para diff-para-added">${afterHtml}</div></div>`;
}

const NO_CHANGE_NOTICE =
	'<div class="diff-content"><p style="color:var(--text-muted);font-size:0.8125rem;padding:0.75rem;font-style:italic">El texto de este artículo no cambió en esta reforma. Es posible que el cambio afecte a su numeración o contexto dentro de la ley.</p></div>';

export function renderBlockDiffHtml(
	beforeText: string,
	afterText: string,
): string {
	if (beforeText === afterText) return NO_CHANGE_NOTICE;

	const bParas = beforeText
		.split(/\n\n/)
		.map((p) => p.trim())
		.filter(Boolean);
	const aParas = afterText
		.split(/\n\n/)
		.map((p) => p.trim())
		.filter(Boolean);

	// LCS diff at paragraph level — detects insertions/deletions correctly
	const paraOps = seqDiff(bParas, aParas, (x, y) => x === y);

	// Group consecutive del+add into modification pairs
	type Group =
		| { t: "mod"; before: string; after: string }
		| { t: "add" | "del"; v: string };
	const groups: Group[] = [];
	let k = 0;
	while (k < paraOps.length) {
		const op = paraOps[k] as DiffOp<string>;
		if (op.t === "del") {
			const next = paraOps[k + 1];
			if (next?.t === "add") {
				groups.push({ t: "mod", before: op.v, after: next.v });
				k += 2;
			} else {
				groups.push({ t: "del", v: op.v });
				k++;
			}
		} else if (op.t === "add") {
			groups.push({ t: "add", v: op.v });
			k++;
		} else {
			// eq — unchanged paragraphs don't need to be shown
			k++;
		}
	}

	if (groups.length === 0) return NO_CHANGE_NOTICE;

	let html = '<div class="diff-content">';
	for (const g of groups) {
		if (g.t === "mod") {
			html += buildWordDiffHtml(g.before, g.after);
		} else if (g.t === "add") {
			html += `<div class="new-block" style="margin:0 0 0.75rem"><div class="version-label">Párrafo añadido</div><div class="version-text">${esc(g.v)}</div></div>`;
		} else {
			html += `<div class="diff-mod-pair"><div class="diff-para diff-para-removed"><span class="diff-label">Eliminado</span><span class="diff-word-removed">${esc(g.v)}</span></div></div>`;
		}
	}
	html += "</div>";
	return html;
}

export function renderUnifiedDiffHtml(diffText: string): string {
	const lines = diffText.split("\n");
	let html = '<div class="unified-diff">';
	let skippedHeader = false;
	for (const line of lines) {
		if (!skippedHeader) {
			if (
				line.startsWith("diff --git") ||
				line.startsWith("index ") ||
				line.startsWith("---") ||
				line.startsWith("+++")
			)
				continue;
			if (line.startsWith("@@")) skippedHeader = true;
		}
		let cls = "unified-diff-line-ctx";
		if (line.startsWith("+") && !line.startsWith("+++"))
			cls = "unified-diff-line-add";
		else if (line.startsWith("-") && !line.startsWith("---"))
			cls = "unified-diff-line-del";
		else if (line.startsWith("@@")) cls = "unified-diff-line-hunk";
		html += `<div class="unified-diff-line ${cls}">${esc(line)}</div>`;
	}
	html += "</div>";
	return html;
}

export interface RenderReformOptions {
	/** Omnibus topic this reform is being viewed under (via ?from=omnibus&topic=N), if any. */
	topicInfo: OmnibusTopic | null;
	/** block_ids restricted to that topic, if resolved. */
	topicBlockIds: string[] | null;
	/** affected_blocks already filtered down to topicBlockIds when applicable. */
	blocks: AffectedBlock[];
	/** Pre-rendered unified diff HTML (from renderUnifiedDiffHtml), used when there
	 *  are no per-block diffs to show (omnibus-less reforms without affected_blocks). */
	unifiedDiffHtml: string | null;
}

export interface RenderReformResult {
	contentHtml: string;
	title: string;
	description: string;
}

/** Renders the full inner HTML of `#reforma-content` for a successfully
 *  fetched reform, plus the page `<title>` and meta description. Pure
 *  function — the caller resolves topic/blocks/diff data before calling. */
export function renderReformContent(
	apiData: ReformDetailResponse,
	opts: RenderReformOptions,
): RenderReformResult {
	const { law, reform } = apiData;
	const { topicInfo, topicBlockIds, blocks, unifiedDiffHtml } = opts;

	const hasHeadline = !!(reform.headline && reform.headline.length > 0);
	const importance = reform.importance || "";
	const rankLabel = RANK_LABELS[law.rank] ?? law.rank ?? "";
	const isDerogatingReform =
		law.status === "derogada" && law.last_reform_date === reform.date;
	const typeLabel = isDerogatingReform
		? "Derogación"
		: (TYPE_LABELS[reform.reform_type ?? ""] ?? "");
	const headline = hasHeadline ? (reform.headline as string) : law.title;
	const fechaLegible = formatDate(reform.date);
	const shortTitle = law.short_title || law.title;

	const title = `${headline} — ${shortTitle} (${fechaLegible})`;
	const description = reform.summary
		? truncate(reform.summary, 150)
		: `Qué cambió en ${law.title} el ${fechaLegible}: ${typeLabel || "modificación"}.`;

	let html = '<div class="reforma-header">';
	html += '<div class="reforma-date-row">';
	html += `<span class="reforma-date">${esc(fechaLegible)}</span>`;
	if (typeLabel)
		html += `<span class="reforma-type-badge"> · ${esc(typeLabel)}</span>`;
	if (importance === "high")
		html += '<span class="reforma-importance-badge">Cambio importante</span>';
	if (topicInfo)
		html += `<span class="reforma-topic-badge">${esc(topicInfo.topic_label)}</span>`;
	html += "</div>";
	html += `<h1 class="reforma-headline">${esc(headline)}</h1>`;
	html += '<div class="reforma-law-info">';
	html += `${esc(rankLabel)} · ${esc(STATUS_LABELS[law.status] ?? law.status)}`;
	html += ` · <a href="/leyes/${encodeURIComponent(law.id)}/">${esc(law.title)}</a>`;
	html += "</div></div>";

	if (reform.summary) {
		html += `<div class="reforma-summary">${esc(reform.summary)}</div>`;
	}

	if (topicBlockIds && blocks.length === 0) {
		html += `<p style="color:var(--text-muted);font-size:0.9375rem;margin-bottom:0.5rem">Los ${topicBlockIds.length} artículo${
			topicBlockIds.length !== 1 ? "s" : ""
		} de este tema no se modificaron en esta reforma.</p>`;
		html += `<p style="font-size:0.875rem"><a href="/cambios/reforma/?id=${encodeURIComponent(law.id)}&date=${encodeURIComponent(
			reform.date,
		)}&from=omnibus" style="color:var(--accent)">Ver todos los cambios de esta reforma →</a></p>`;
	}

	if (blocks.length > 0) {
		html += '<section class="reforma-changes">';
		html += `<h2>Qué ha cambiado <span class="reforma-changes-count">(${blocks.length} artículo${blocks.length !== 1 ? "s" : ""})</span></h2>`;
		blocks.forEach((b, i) => {
			const isNew = !b.before_text;
			const isOpen = i < 5;
			const isNotaInicial =
				b.block_type === "nota_inicial" || b.block_id === "no";
			const blockLabel = isNotaInicial
				? "Nota oficial del BOE"
				: b.title || b.block_id;
			const diffHtml = isNew
				? ""
				: renderBlockDiffHtml(b.before_text as string, b.after_text);

			html += '<div class="block-change">';
			html += `<div class="block-change-header" data-idx="${i}">`;
			html += `<span>${esc(blockLabel)}</span>`;
			html += `<span style="font-size:0.75rem;color:var(--text-muted)">${isOpen ? "▾" : "▸"}</span>`;
			html += "</div>";
			html += `<div class="block-change-body${isOpen ? " open" : ""}" id="block-${i}">`;
			if (isNew) {
				html += '<div class="new-block">';
				html += `<div class="version-label">${isNotaInicial ? "Aviso oficial" : "Artículo nuevo"}</div>`;
				html += `<div class="version-text">${esc(b.after_text)}</div>`;
				html += "</div>";
			} else {
				html += `<div>${diffHtml}</div>`;
			}
			html += "</div></div>";
		});
		html += "</section>";
	} else if (apiData.prev_reform_date && !topicBlockIds) {
		html += '<section class="reforma-changes">';
		html += "<h2>Qué ha cambiado</h2>";
		html += unifiedDiffHtml
			? unifiedDiffHtml
			: '<p style="color:var(--text-muted);font-size:0.875rem">No se encontraron diferencias para esta reforma.</p>';
		html += "</section>";
	}

	html += '<nav class="reforma-nav">';
	html += `<a href="/leyes/${encodeURIComponent(law.id)}/?from=reforma">Ver ley completa →</a>`;
	html += `<a href="${esc(apiData.source_url)}" target="_blank" rel="noopener">Ver en BOE ↗</a>`;
	html += "</nav>";

	return { contentHtml: html, title, description };
}
