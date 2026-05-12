/**
 * Scrape DGT (Dirección General de Tributos) "consultas vinculantes" — public
 * binding tax-law rulings where a citizen/business question is paired with the
 * specific law/article that applies. ~19,700 consultas total, all freely
 * accessible via two endpoints once a JSP session is bootstrapped.
 *
 * Each consulta exposes:
 *   - NUM-CONSULTA   (e.g. "V0001-24")
 *   - ORGANO         (issuing sub-directorate)
 *   - FECHA-SALIDA   (DD/MM/YYYY)
 *   - NORMATIVA      (e.g. "Ley 40/1998, Art. 7-e") — the cited law
 *   - CUESTION-PLANTEADA  (the question, citizen-style)
 *   - DESCRIPCION-HECHOS  (the facts)
 *   - CONTESTACION-COMPL  (the answer)
 *
 * We extract enough to build {question, normativaText, ...} entries. A later
 * step (`map-dgt-to-boe.ts`) maps "Ley 40/1998" → BOE-A-IDs against our DB.
 *
 * Strategy:
 *  1. Bootstrap session (GET /consultas/).
 *  2. Execute search to populate server-side state.
 *  3. Iterate N pages from page 1 (each page = 20 consultas, stratified across
 *     years by NUM-CONSULTA order). Default: 25 pages = ~500 consultas.
 *  4. For each consulta doc_NNNN, fetch the detail endpoint.
 *  5. Append to JSONL incrementally so partial failures don't lose work.
 *
 * Usage:
 *   bun packages/api/research/ab/scrape-dgt-consultas.ts \
 *     [--pages 25] \
 *     [--out data/external/dgt-consultas.jsonl] \
 *     [--delay-ms 300]
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
function resolvePath(p: string): string {
	return isAbsolute(p) ? p : join(repoRoot, p);
}

const pages = Number(flag("pages") ?? "25");
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "data/external/dgt-consultas.jsonl");
const delayMs = Number(flag("delay-ms") ?? "300");

mkdirSync(dirname(outPath), { recursive: true });

const BASE = "https://petete.tributos.hacienda.gob.es";
const SEARCH_URL =
	`${BASE}/consultas/do/search?type1=on&type2=on&NMCMP_1=NUM-CONSULTA&VLCMP_1=&OPCMP_1=.Y` +
	`&NMCMP_2=FECHA-SALIDA&VLCMP_2=&dateIni_2=&OPCMP_2=.Y` +
	`&NMCMP_3=NORMATIVA&VLCMP_3=&OPCMP_3=.Y` +
	`&NMCMP_4=CUESTION-PLANTEADA&VLCMP_4=&OPCMP_4=.Y` +
	`&NMCMP_5=DESCRIPCION-HECHOS&VLCMP_5=&OPCMP_5=.Y` +
	`&NMCMP_6=FreeText&VLCMP_6=&OPCMP_6=.Y` +
	`&NMCMP_7=CRITERIO&cmpOrder=NUM-CONSULTA&dirOrder=0&auto=&tab=1`;

const COMMON_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
	Accept: "text/html, */*; q=0.01",
	"Accept-Language": "es-ES,es;q=0.9",
	"X-Requested-With": "XMLHttpRequest",
	Referer: `${BASE}/consultas`,
} as const;

let sessionCookie = "";

async function bootstrap(): Promise<void> {
	const res = await fetch(`${BASE}/consultas/`, { headers: COMMON_HEADERS });
	const setCookie = res.headers.get("set-cookie") ?? "";
	const m = setCookie.match(/JSESSIONID=([^;]+)/);
	if (!m) throw new Error(`Bootstrap failed; no JSESSIONID in: ${setCookie}`);
	sessionCookie = `JSESSIONID=${m[1]}`;
	console.log(`Session: ${sessionCookie}`);
}

async function fetchWithCookie(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: { ...COMMON_HEADERS, Cookie: sessionCookie },
	});
	if (res.status === 401) {
		// Session expired — re-bootstrap and retry once.
		console.log("  [session expired, re-bootstrapping]");
		await bootstrap();
		await primeSession();
		const retry = await fetch(url, {
			headers: { ...COMMON_HEADERS, Cookie: sessionCookie },
		});
		if (!retry.ok) throw new Error(`Retry ${retry.status} for ${url}`);
		return retry.text();
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return res.text();
}

async function primeSession(): Promise<void> {
	// Must run a search before details work — populates server-side query state.
	await fetchWithCookie(`${SEARCH_URL}&page=1`);
}

interface ConsultaEntry {
	docId: string;
	numConsulta: string;
	organo: string;
	fechaSalida: string; // DD/MM/YYYY
	normativa: string; // raw text from NORMATIVA field
	cuestion: string; // CUESTION-PLANTEADA
	descripcion: string; // DESCRIPCION-HECHOS
	contestacion: string; // CONTESTACION-COMPL (truncated to first 1000 chars to keep file small)
}

// Decode common HTML entities in a single pass so that decoding `&amp;`
// can never accidentally feed another entity back in (e.g. `&amp;lt;`
// must remain literal `&lt;`, not become `<`).
const HTML_ENTITIES: Record<string, string> = {
	"&aacute;": "á",
	"&eacute;": "é",
	"&iacute;": "í",
	"&oacute;": "ó",
	"&uacute;": "ú",
	"&Aacute;": "Á",
	"&Eacute;": "É",
	"&Iacute;": "Í",
	"&Oacute;": "Ó",
	"&Uacute;": "Ú",
	"&ntilde;": "ñ",
	"&Ntilde;": "Ñ",
	"&uuml;": "ü",
	"&iquest;": "¿",
	"&iexcl;": "¡",
	"&ordm;": "º",
	"&ordf;": "ª",
	"&laquo;": "«",
	"&raquo;": "»",
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

const HTML_ENTITY_RE = new RegExp(
	Object.keys(HTML_ENTITIES).join("|").replace(/[#]/g, "\\#"),
	"g",
);

function decodeEntities(s: string): string {
	return s.replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] ?? m);
}

// Extract the text content of all <p class="FIELD">...</p> blocks for a field.
function extractField(html: string, field: string): string {
	const re = new RegExp(`<p class="${field}"[^>]*>([\\s\\S]*?)<\\/p>`, "g");
	const parts: string[] = [];
	for (const m of html.matchAll(re)) {
		const inner = m[1] ?? "";
		// Strip remaining tags.
		const text = inner
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) parts.push(decodeEntities(text));
	}
	return parts.join("\n\n");
}

function extractDocIdsFromPage(html: string): string[] {
	const ids: string[] = [];
	for (const m of html.matchAll(/id="doc_(\d+)"/g)) ids.push(m[1]!);
	return [...new Set(ids)];
}

async function fetchDetail(docId: string): Promise<ConsultaEntry | null> {
	const url = `${BASE}/consultas/do/document?query=.T&doc=${docId}&tab=1`;
	const html = await fetchWithCookie(url);

	const numConsulta = extractField(html, "NUM-CONSULTA");
	const organo = extractField(html, "ORGANO");
	const fechaSalida = extractField(html, "FECHA-SALIDA");
	const normativa = extractField(html, "NORMATIVA");
	const cuestion = extractField(html, "CUESTION-PLANTEADA");
	const descripcion = extractField(html, "DESCRIPCION-HECHOS");
	const contestacion = extractField(html, "CONTESTACION-COMPL").slice(0, 1000);

	// Skip entries marked as anulada / sin contenido.
	if (!cuestion || cuestion.length < 10) return null;
	if (!normativa) return null;

	return {
		docId,
		numConsulta,
		organo,
		fechaSalida,
		normativa,
		cuestion,
		descripcion,
		contestacion,
	};
}

// Resume support: track which docIds we've already saved.
const seen = new Set<string>();
if (existsSync(outPath) && statSync(outPath).size > 0) {
	const existing = (await Bun.file(outPath).text()).trim().split("\n");
	for (const line of existing) {
		try {
			const obj = JSON.parse(line);
			if (obj?.docId) seen.add(String(obj.docId));
		} catch {}
	}
	console.log(`Resuming: ${seen.size} entries already in ${outPath}`);
}

await bootstrap();
await primeSession();

let totalKept = 0;
let totalSkipped = 0;

for (let page = 1; page <= pages; page++) {
	const pageUrl = `${SEARCH_URL}&page=${page}`;
	const pageHtml = await fetchWithCookie(pageUrl);
	const docIds = extractDocIdsFromPage(pageHtml);
	console.log(`Page ${page}/${pages}: ${docIds.length} docs`);
	for (const id of docIds) {
		if (seen.has(id)) continue;
		try {
			const entry = await fetchDetail(id);
			if (entry) {
				appendFileSync(outPath, `${JSON.stringify(entry)}\n`);
				seen.add(id);
				totalKept++;
			} else {
				totalSkipped++;
			}
		} catch (err) {
			console.error(
				`  doc ${id} FAILED: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await new Promise((r) => setTimeout(r, delayMs));
	}
}

console.log(`\nDone. Kept ${totalKept}, skipped ${totalSkipped}.`);
console.log(`Output: ${outPath}`);
