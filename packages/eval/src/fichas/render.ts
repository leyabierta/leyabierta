/**
 * Ficha rendering (Markdown, for judges and humans) and mechanical checks.
 */

export interface Ficha {
	titular?: string;
	resumen?: string[];
	modifica?: string[];
	cambios?: Array<{
		tema?: string;
		antes?: string | null;
		ahora?: string;
		ref?: string;
	}>;
	otros_cambios?: string[];
	perfiles?: Array<{ si_eres?: string; puntos?: string[] }>;
	fechas?: Array<{ que?: string; cuando?: string; ref?: string }>;
	que_no_hace?: string[];
	dudas?: string[];
}

const list = (items: string[] | undefined) =>
	(items ?? []).map((s) => `- ${s}`).join("\n");

export function renderFicha(title: string, raw: unknown): string {
	const f = raw as Ficha;
	const out: string[] = [`# ${f.titular ?? ""}`, "", `_${title}_`, ""];
	out.push("## En 30 segundos", "", list(f.resumen), "");
	if (f.modifica?.length)
		out.push("## Qué leyes modifica", "", list(f.modifica), "");
	if (f.cambios?.length) {
		out.push("## Qué cambia", "");
		for (const c of f.cambios) {
			const ahora = c.ahora ?? "";
			// Writers often already end "ahora" with its [ref]; do not repeat it.
			const ref = c.ref && !ahora.includes(`[${c.ref}]`) ? ` [${c.ref}]` : "";
			out.push(
				`- **${c.tema ?? ""}.** ${c.antes ? `Antes: ${c.antes} ` : ""}Ahora: ${ahora}${ref}`,
			);
		}
		out.push("");
	}
	if (f.otros_cambios?.length)
		out.push("### Otros cambios", "", list(f.otros_cambios), "");
	for (const p of f.perfiles ?? []) {
		out.push(`## Si eres ${p.si_eres ?? ""}`, "", list(p.puntos), "");
	}
	if (f.fechas?.length) {
		out.push("## Fechas", "");
		for (const d of f.fechas)
			out.push(`- ${d.que ?? ""}: ${d.cuando ?? ""} [${d.ref ?? ""}]`);
		out.push("");
	}
	if (f.que_no_hace?.length)
		out.push("## Qué no hace", "", list(f.que_no_hace), "");
	if (f.dudas?.length) out.push("## Dudas del texto", "", list(f.dudas), "");
	return `${out.join("\n").trim()}\n`;
}

function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/[«»“”"'‘’]/g, "")
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
}

function collectQuotes(node: unknown, acc: string[] = []): string[] {
	if (Array.isArray(node)) for (const n of node) collectQuotes(n, acc);
	else if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node)) {
			if (k === "cita" && typeof v === "string" && v.trim()) acc.push(v);
			else collectQuotes(v, acc);
		}
	}
	return acc;
}

const NUMBER = /\d+(?:[.,]\d+)*/g;
const canonNumber = (n: string) =>
	n.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");

export interface FichaChecks {
	quotesTotal: number;
	quotesFound: number;
	missingQuotes: string[];
	unsupportedNumbers: string[];
}

/**
 * Quotes must appear verbatim (modulo case, quotes and whitespace; a trailing
 * ellipsis or punctuation is tolerated). Every number written in the ficha
 * must appear somewhere in the source.
 */
export function checkFicha(
	extraction: unknown,
	ficha: unknown,
	source: string,
): FichaChecks {
	const src = normalize(source);
	const quotes = collectQuotes(extraction);
	const missingQuotes = quotes.filter((q) => {
		const n = normalize(q).replace(/^[.…\s]+|[.…;,:\s]+$/g, "");
		return !n || !src.includes(n);
	});
	const sourceNumbers = new Set((source.match(NUMBER) ?? []).map(canonNumber));
	// References ([art. 235.1.10.º CP], "ref" fields) are locators, not facts.
	const fichaText = JSON.stringify(ficha, (k, v) =>
		k === "ref" ? undefined : v,
	).replace(/\[[^\]]*\]/g, "");
	const unsupported = new Set<string>();
	for (const n of fichaText.match(NUMBER) ?? []) {
		if (!sourceNumbers.has(canonNumber(n))) unsupported.add(n);
	}
	return {
		quotesTotal: quotes.length,
		quotesFound: quotes.length - missingQuotes.length,
		missingQuotes,
		unsupportedNumbers: [...unsupported],
	};
}
