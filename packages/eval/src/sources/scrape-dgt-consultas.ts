/**
 * Scrape ALL DGT (Dirección General de Tributos) consultas — both "generales"
 * (~19,693) and "vinculantes" (~68,929). Total: ~88,622 entries.
 *
 * Each consulta exposes:
 *   - NUM-CONSULTA   (e.g. "V0001-24")
 *   - ORGANO         (issuing sub-directorate)
 *   - FECHA-SALIDA   (DD/MM/YYYY)
 *   - NORMATIVA      (e.g. "Ley 40/1998, Art. 7-e") — the cited law
 *   - CUESTION-PLANTEADA  (the question, citizen-style)
 *   - DESCRIPCION-HECHOS  (the facts)
 *   - CONTESTACION-COMPL  (the answer, full text)
 *
 * We extract enough to build {question, normativaText, ...} entries. A later
 * step (`map-dgt-to-gold.ts`) maps "Ley 40/1998" → BOE-A-IDs against our DB.
 *
 * Strategy:
 *  1. Bootstrap session (GET /consultas/).
 *  2. Execute search to populate server-side state (per category).
 *  3. Auto-discover total pages from pagination HTML.
 *  4. For each consulta doc_NNNN, fetch the detail endpoint.
 *  5. Append to JSONL incrementally so partial failures don't lose work.
 *  6. Resume support: skips docIds already in output file.
 *
 * Usage:
 *   bun packages/eval/src/sources/scrape-dgt-consultas.ts \
 *     [--pages 50]    # override: max pages per category (default: auto) \
 *     [--out /Volumes/Disco1TB/datasets/leyabierta/dgt-consultas/raw/dgt-consultas-full.jsonl] \
 *     [--delay-ms 300]
 */

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// Trust system certs + skip verification for gov sites with self-signed chains
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
function resolvePath(p: string): string {
	return isAbsolute(p) ? p : join(repoRoot, p);
}

const pagesOverride = Number(flag("pages") ?? "0"); // 0 = auto-discover
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "data/external/dgt-consultas-full.jsonl");
const delayMs = Number(flag("delay-ms") ?? "300");

mkdirSync(dirname(outPath), { recursive: true });

const BASE = "https://petete.tributos.hacienda.gob.es";

const SEARCH_URLS = {
	generales: `${BASE}/consultas/do/search?type1=on&type2=off&NMCMP_1=NUM-CONSULTA&VLCMP_1=&OPCMP_1=.Y&NMCMP_2=FECHA-SALIDA&VLCMP_2=&dateIni_2=&OPCMP_2=.Y&NMCMP_3=NORMATIVA&VLCMP_3=&OPCMP_3=.Y&NMCMP_4=CUESTION-PLANTEADA&VLCMP_4=&OPCMP_4=.Y&NMCMP_5=DESCRIPCION-HECHOS&VLCMP_5=&OPCMP_5=.Y&NMCMP_6=FreeText&VLCMP_6=&OPCMP_6=.Y&NMCMP_7=CRITERIO&cmpOrder=NUM-CONSULTA&dirOrder=0&auto=&tab=1`,
	vinculantes: `${BASE}/consultas/do/search?type1=off&type2=on&NMCMP_1=NUM-CONSULTA&VLCMP_1=&OPCMP_1=.Y&NMCMP_2=FECHA-SALIDA&VLCMP_2=&dateIni_2=&OPCMP_2=.Y&NMCMP_3=NORMATIVA&VLCMP_3=&OPCMP_3=.Y&NMCMP_4=CUESTION-PLANTEADA&VLCMP_4=&OPCMP_4=.Y&NMCMP_5=DESCRIPCION-HECHOS&VLCMP_5=&OPCMP_5=.Y&NMCMP_6=FreeText&VLCMP_6=&OPCMP_6=.Y&NMCMP_7=CRITERIO&cmpOrder=NUM-CONSULTA&dirOrder=0&auto=&tab=2`,
};

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
let currentCategory: keyof typeof SEARCH_URLS = "generales";

async function bootstrap(): Promise<void> {
	const res = await fetch(`${BASE}/consultas/`, { headers: COMMON_HEADERS });
	const setCookie = res.headers.get("set-cookie") ?? "";
	const m = setCookie.match(/JSESSIONID=([^;]+)/);
	if (!m) throw new Error(`Bootstrap failed; no JSESSIONID in: ${setCookie}`);
	sessionCookie = `JSESSIONID=${m[1]}`;
}

async function fetchWithCookie(url: string): Promise<string> {
	// Server's reverse proxy emits 502 when its backend takes too long.
	// Retrying fast hits the same saturated state — back off generously to
	// let the backend recover. Schedule: 30s → 60s → 120s → 240s → 480s.
	const maxAttempts = 5;
	const backoffs = [30_000, 60_000, 120_000, 240_000, 480_000];
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const res = await fetch(url, {
				headers: { ...COMMON_HEADERS, Cookie: sessionCookie },
			});
			if (res.status === 401) {
				console.log("  [session expired, re-bootstrapping]");
				await bootstrap();
				await primeSession(currentCategory);
				continue;
			}
			if (res.status >= 500 && res.status < 600) {
				const wait = backoffs[attempt - 1] ?? 480_000;
				console.log(
					`  [HTTP ${res.status}, retry ${attempt}/${maxAttempts} in ${Math.round(wait / 1000)}s]`,
				);
				await new Promise((r) => setTimeout(r, wait));
				continue;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
			return res.text();
		} catch (err) {
			lastErr = err;
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.startsWith("HTTP ") && !msg.includes(" 5")) throw err;
			const wait = backoffs[attempt - 1] ?? 480_000;
			console.log(
				`  [fetch error ${attempt}/${maxAttempts}: ${msg}; retry in ${Math.round(wait / 1000)}s]`,
			);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
	throw lastErr instanceof Error
		? lastErr
		: new Error(`Failed after ${maxAttempts} attempts: ${url}`);
}

async function primeSession(
	category: keyof typeof SEARCH_URLS = "generales",
): Promise<void> {
	await fetchWithCookie(`${SEARCH_URLS[category]}&page=1`);
}

interface ConsultaEntry {
	docId: string;
	numConsulta: string;
	organo: string;
	fechaSalida: string;
	normativa: string;
	cuestion: string;
	descripcion: string;
	contestacion: string;
	category: "generales" | "vinculantes";
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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HTML_ENTITY_RE = new RegExp(
	Object.keys(HTML_ENTITIES).map(escapeRegex).join("|"),
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

function extractTotalPages(html: string): number {
	// Pattern: onGoPage(event, 1, TOTAL_PAGES) in pagination input
	const m = html.match(/onGoPage\(event,\s*\d+,\s*(\d+)\)/);
	if (m) return Number(m[1]);
	// Fallback: searchPage(1, TOTAL_PAGES) in last-page link
	const m2 = html.match(/searchPage\(\d+,\s*(\d+)\)/);
	if (m2) return Number(m2[1]);
	return 0;
}

async function fetchDetail(
	docId: string,
	category: string,
): Promise<ConsultaEntry | null> {
	const tab = category === "vinculantes" ? 2 : 1;
	const url = `${BASE}/consultas/do/document?query=.T&doc=${docId}&tab=${tab}`;
	const html = await fetchWithCookie(url);

	const numConsulta = extractField(html, "NUM-CONSULTA");
	const organo = extractField(html, "ORGANO");
	const fechaSalida = extractField(html, "FECHA-SALIDA");
	const normativa = extractField(html, "NORMATIVA");
	const cuestion = extractField(html, "CUESTION-PLANTEADA");
	const descripcion = extractField(html, "DESCRIPCION-HECHOS");
	const contestacion = extractField(html, "CONTESTACION-COMPL");

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
		category,
	};
}

// ── Resume support ──
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

// ── Main scrape loop ──

let totalKept = seen.size;
let totalSkipped = 0;
let totalDocsFetched = 0;

const categories = [
	// { name: "generales", url: SEARCH_URLS.generales },  // skipped: all ~19.7k docIds already scraped
	{ name: "vinculantes", url: SEARCH_URLS.vinculantes },
];

for (const cat of categories) {
	console.log(`\n=== Category: ${cat.name} ===`);
	currentCategory = cat.name as keyof typeof SEARCH_URLS;

	// Re-bootstrap + prime for this category so server-side state is correct
	await bootstrap();
	await primeSession(currentCategory);

	// Page 1 uses the heavy search URL (executes the query). Pages 2+ use a
	// lightweight URL that reuses the cached search state in the session —
	// this matches what the browser does and avoids re-running the search
	// (the main source of 502s).
	const tab = cat.name === "vinculantes" ? 2 : 1;
	const lightPageUrl = (page: number) =>
		`${BASE}/consultas/do/search?query=.T&order=NUM-CONSULTA%7C0&tab=${tab}&page=${page}`;

	const firstPageHtml = await fetchWithCookie(`${cat.url}&page=1`);
	const totalPages =
		pagesOverride > 0 ? pagesOverride : extractTotalPages(firstPageHtml) || 100;

	console.log(`  Total pages to fetch: ${totalPages}`);

	const pageStartTs = Date.now();
	const detailConcurrency = 3;

	async function processDoc(id: string): Promise<void> {
		if (seen.has(id)) return;
		totalDocsFetched++;
		try {
			const entry = await fetchDetail(id, cat.name);
			if (entry) {
				appendFileSync(outPath, `${JSON.stringify(entry)}\n`);
				seen.add(id);
				totalKept++;
			} else {
				seen.add(id);
				totalSkipped++;
			}
		} catch (err) {
			console.error(
				`  doc ${id} FAILED: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	for (let page = 1; page <= totalPages; page++) {
		const pageUrl = page === 1 ? `${cat.url}&page=1` : lightPageUrl(page);
		const pageHtml = await fetchWithCookie(pageUrl);
		const docIds = extractDocIdsFromPage(pageHtml);
		if (docIds.length === 0) {
			console.warn(
				`  ⚠ Page ${page}/${totalPages} returned 0 docIds — possible silent loss`,
			);
		}

		if (page % 10 === 0 || page === 1 || page === totalPages) {
			const elapsedS = (Date.now() - pageStartTs) / 1000;
			const pagesPerSec = page / (elapsedS || 1);
			const etaMin = (totalPages - page) / (pagesPerSec || 1) / 60;
			console.log(
				`  Page ${page}/${totalPages}: ${docIds.length} docs | kept=${totalKept} | ${pagesPerSec.toFixed(2)} pages/s | ETA ${etaMin.toFixed(1)}min`,
			);
		}

		// Process this page's docs with bounded concurrency
		const queue = [...docIds];
		const workers: Promise<void>[] = [];
		for (let w = 0; w < detailConcurrency; w++) {
			workers.push(
				(async () => {
					while (queue.length > 0) {
						const id = queue.shift();
						if (!id) break;
						await processDoc(id);
						await new Promise((r) => setTimeout(r, delayMs));
					}
				})(),
			);
		}
		await Promise.all(workers);
	}
}

console.log(`\n=== FINAL RESULTS ===`);
console.log(`Total entries kept:   ${totalKept}`);
console.log(`Total entries skipped: ${totalSkipped}`);
console.log(`Total docs fetched:   ${totalDocsFetched}`);
console.log(`Output: ${outPath}`);

const summaryPath = outPath.replace(".jsonl", ".summary.json");
await Bun.write(
	summaryPath,
	JSON.stringify(
		{
			totalKept,
			totalSkipped,
			totalDocsFetched,
			outputPath: outPath,
			finishedAt: new Date().toISOString(),
		},
		null,
		2,
	),
);
console.log(`Summary: ${summaryPath}`);
