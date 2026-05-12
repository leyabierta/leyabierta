/**
 * Map DGT consultas (output of scrape-dgt-consultas.ts) to our gold-eval
 * format by resolving the cited `normativa` strings into BOE-A-IDs against
 * our local norms DB.
 *
 * Strategy:
 *  1. Read each line of data/external/dgt-consultas.jsonl.
 *  2. Parse the `normativa` field with regex to extract law refs:
 *     - "Ley N/YYYY"
 *     - "Ley Orgánica N/YYYY"  (also "LO N/YYYY")
 *     - "Real Decreto N/YYYY"
 *     - "Real Decreto-Ley N/YYYY"  (also "RD-Ley", "RDL")
 *     - "Real Decreto Legislativo N/YYYY"  (also "RD Leg", "RDLeg")
 *     - "Ley Foral N/YYYY"
 *  3. For each ref, look up the BOE-A-ID via title LIKE match in `norms`.
 *  4. Output gold entries `{id, question, expectedNorms, category, source}`.
 *  5. Drop entries whose normativa couldn't be mapped (cited only derogated
 *     laws not in our corpus).
 *
 * Usage:
 *   bun packages/api/research/ab/map-dgt-to-gold.ts \
 *     [--in  data/external/dgt-consultas.jsonl] \
 *     [--out packages/api/research/datasets/gold-eval-dgt.json] \
 *     [--unmapped-out data/external/dgt-unmapped.jsonl]
 */

import { Database } from "bun:sqlite";
import { isAbsolute, join } from "node:path";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

const repoRoot = join(import.meta.dir, "../../../../");
function resolvePath(p: string): string {
	return isAbsolute(p) ? p : join(repoRoot, p);
}

const inPath = flag("in")
	? resolvePath(flag("in")!)
	: join(repoRoot, "data/external/dgt-consultas.jsonl");
const outPath = flag("out")
	? resolvePath(flag("out")!)
	: join(repoRoot, "packages/api/research/datasets/gold-eval-dgt.json");
const unmappedPath = flag("unmapped-out")
	? resolvePath(flag("unmapped-out")!)
	: join(repoRoot, "data/external/dgt-unmapped.jsonl");

const db = new Database(join(repoRoot, "data/leyabierta.db"), {
	readonly: true,
});

interface Consulta {
	docId: string;
	numConsulta: string;
	organo: string;
	fechaSalida: string; // DD/MM/YYYY
	normativa: string;
	cuestion: string;
	descripcion: string;
	contestacion: string;
}

// Regex patterns for Spanish legal citations
// We extract `kind` and `number/year` separately for flexible matching.
interface LawRef {
	kind: string; // canonical kind: "Ley", "Real Decreto", "Real Decreto Legislativo", etc.
	number: string;
	year: string;
	raw: string;
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
	{
		kind: "Ley Orgánica",
		re: /(?:Ley Org[áa]nica|L\.?\s*O\.?|LO)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Real Decreto Legislativo",
		re: /(?:Real Decreto Legislativo|R\.?D\.?\s*Leg(?:islativo)?\.?|RD Leg|RDLeg)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Real Decreto-Ley",
		re: /(?:Real Decreto-?\s*[Ll]ey|R\.?D\.?-?\s*[Ll]ey|RD-?L)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Real Decreto",
		re: /(?:Real Decreto|R\.?D\.?)\.?\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Ley Foral",
		re: /Ley Foral\s+(\d+)\/((?:19|20)\d{2})/g,
	},
	{
		kind: "Ley",
		re: /Ley\s+(\d+)\/((?:19|20)\d{2})/g,
	},
];

function extractLawRefs(normativa: string): LawRef[] {
	const refs: LawRef[] = [];
	const claimed = new Set<string>(); // mark "position-length" spans claimed by earlier (more specific) patterns
	for (const { kind, re } of PATTERNS) {
		for (const m of normativa.matchAll(re)) {
			const key = `${m.index}-${m[0]!.length}`;
			// Skip if this exact span was claimed by a more-specific kind already.
			// Patterns are ordered most-specific → least-specific, so the first
			// hit wins.
			if (claimed.has(key)) continue;
			// Also skip if any previous claim overlaps significantly with this one
			let overlap = false;
			for (const c of claimed) {
				const [pos, len] = c.split("-").map(Number);
				if (m.index! >= pos! && m.index! < pos! + len!) {
					overlap = true;
					break;
				}
			}
			if (overlap) continue;
			claimed.add(key);
			refs.push({
				kind,
				number: m[1]!,
				year: m[2]!,
				raw: m[0]!,
			});
		}
	}
	return refs;
}

// Title patterns to match against:
//   "Ley 37/1992, de 28 de diciembre..."
//   "Real Decreto 1624/1992, de 29 de diciembre..."
function titlePrefix(ref: LawRef): string {
	return `${ref.kind} ${ref.number}/${ref.year}%`;
}

const lookupStmt = db.query<
	{ id: string; status: string; title: string },
	[string]
>(
	"SELECT id, status, substr(title, 1, 200) as title FROM norms WHERE title LIKE ? LIMIT 5",
);

interface GoldEntry {
	id: string;
	question: string;
	expectedNorms: string[];
	category: string;
	source: {
		origin: "dgt-consulta";
		numConsulta: string;
		fechaSalida: string;
		organo: string;
		rawNormativa: string;
		extractedRefs: Array<{ kind: string; number: string; year: string }>;
		descripcion: string;
		contestacionSnippet: string;
	};
}

function hashId(q: string): string {
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(q);
	return `qd_${hasher.digest("hex").slice(0, 8)}`;
}

const lines = (await Bun.file(inPath).text()).trim().split("\n");
console.log(`Reading ${lines.length} consultas from ${inPath}`);

const gold: GoldEntry[] = [];
const unmappedRecords: Array<{
	docId: string;
	numConsulta: string;
	normativa: string;
	refs: LawRef[];
}> = [];

let totalRefs = 0;
let mappedRefs = 0;

for (const line of lines) {
	if (!line.trim()) continue;
	const c = JSON.parse(line) as Consulta;
	const refs = extractLawRefs(c.normativa);
	totalRefs += refs.length;

	const expectedNorms = new Set<string>();
	for (const ref of refs) {
		const rows = lookupStmt.all(titlePrefix(ref));
		// Prefer vigente over derogada. If multiple matches, take all vigente
		// (rare, mostly there's one).
		const vigentes = rows.filter((r) => r.status === "vigente");
		const winners = vigentes.length > 0 ? vigentes : rows;
		for (const w of winners) expectedNorms.add(w.id);
		if (winners.length > 0) mappedRefs++;
	}

	// Combine cuestion + descripcion as the query when descripcion exists and
	// adds useful context (e.g. citizen facts the consulta is about).
	let question = c.cuestion;
	if (
		c.descripcion &&
		c.descripcion.length > 30 &&
		c.descripcion.length < 300
	) {
		question = `${c.descripcion} ${c.cuestion}`;
	}

	if (expectedNorms.size === 0) {
		unmappedRecords.push({
			docId: c.docId,
			numConsulta: c.numConsulta,
			normativa: c.normativa,
			refs,
		});
		continue;
	}

	gold.push({
		id: hashId(question),
		question,
		expectedNorms: [...expectedNorms],
		category: c.organo,
		source: {
			origin: "dgt-consulta",
			numConsulta: c.numConsulta,
			fechaSalida: c.fechaSalida,
			organo: c.organo,
			rawNormativa: c.normativa,
			extractedRefs: refs.map((r) => ({
				kind: r.kind,
				number: r.number,
				year: r.year,
			})),
			descripcion: c.descripcion,
			contestacionSnippet: c.contestacion.slice(0, 300),
		},
	});
}

console.log(`\nMapping stats:`);
console.log(`  Consultas total:        ${lines.length}`);
console.log(`  Refs extracted total:   ${totalRefs}`);
console.log(
	`  Refs successfully mapped: ${mappedRefs} (${((mappedRefs / Math.max(totalRefs, 1)) * 100).toFixed(1)}%)`,
);
console.log(`  Gold entries kept:      ${gold.length}`);
console.log(`  Unmapped consultas:     ${unmappedRecords.length}`);

// Year distribution of kept vs unmapped
function yearDist(
	items: Array<{ year?: string; fechaSalida?: string }>,
): Record<string, number> {
	const d: Record<string, number> = {};
	for (const it of items) {
		const fecha = "fechaSalida" in it ? it.fechaSalida : undefined;
		if (!fecha) continue;
		const y = fecha.slice(6, 10);
		d[y] = (d[y] ?? 0) + 1;
	}
	return d;
}
console.log(`\nKept by year:`);
const yd = yearDist(gold.map((g) => ({ fechaSalida: g.source.fechaSalida })));
for (const [y, n] of Object.entries(yd).sort()) console.log(`  ${y}: ${n}`);

await Bun.write(outPath, JSON.stringify({ results: gold }, null, 2));
console.log(`\nWrote gold → ${outPath}`);

await Bun.write(
	unmappedPath,
	unmappedRecords.map((u) => JSON.stringify(u)).join("\n"),
);
console.log(`Wrote unmapped → ${unmappedPath}`);
