/**
 * Quota table for the stratified sampler.
 *
 * ── Math ──
 * Goal: ~2000 accepted questions in the eval dataset. Empirically the multi-
 * agent pipeline accepts ≈40% of generated drafts (the 3-of-3 judge panel,
 * the leak detector, the citizen-voice critic and dedup all knock items out),
 * so we need ≈ 2000 / 0.40 = 5000 seeds total.
 *
 * Stratification cells: (materia × jurisdiction × rank × decade).
 *   - top 30 materias + "_other"                         → 31 buckets
 *   - jurisdictions with ≥50 vigente norms + "_other"     → ~18 buckets
 *   - 7 ranks (ley, ley-organica, real-decreto,
 *              real-decreto-ley, real-decreto-legislativo,
 *              orden, otros)                              → 7
 *   - 6 decades (1970s … 2020s)                           → 6
 * Cartesian product is huge (≈23k cells) but the corpus only populates a
 * fraction of them. We size each populated cell by:
 *
 *     target(cell) = clamp( round(BASE * density(cell) ^ ALPHA), MIN, MAX )
 *
 * where
 *     density(cell) = #eligible_articles_in_cell / #eligible_articles_total
 *     ALPHA = 0.7   (sub-linear: rich cells contribute, but tail is preserved)
 *     BASE  = 5000  (target seed budget)
 *     MIN   = 1     (any populated cell deserves at least 1 seed)
 *     MAX   = 50    (no cell may dominate the dataset)
 *
 * After computing per-cell quotas we re-scale globally so that the sum is
 * exactly the requested seed budget (default 5000). The MIN/MAX caps are
 * re-applied after rescaling to avoid hot cells eating the tail.
 *
 * In addition we apply a (materia × decade) floor of 5 seeds when that cross-
 * cell has data, to guarantee thematic and temporal coverage independent of
 * jurisdiction/rank skew.
 */

export interface CellKey {
	materia: string;
	jurisdiction: string;
	rank: string;
	decade: string;
}

export interface QuotaInputs {
	/** Map "materia|jurisdiction|rank|decade" → eligible article count. */
	cellCounts: Map<string, number>;
	/** Total seed budget (default 5000). */
	budget?: number;
	min?: number;
	max?: number;
	alpha?: number;
	/** Floor applied to every populated (materia × decade) cross-cell. */
	materiaDecadeFloor?: number;
}

export interface QuotaResult {
	/** Map cell-key → target seed count. */
	targets: Map<string, number>;
	totalTarget: number;
}

export const DEFAULT_BUDGET = 5000;
export const DEFAULT_MIN = 1;
export const DEFAULT_MAX = 50;
export const DEFAULT_ALPHA = 0.7;
export const DEFAULT_MATERIA_DECADE_FLOOR = 5;

/**
 * Bucket name used when a norm has no thematic materias (either because the
 * BOE never tagged it, or because the only tags it had were geographic — see
 * `GEOGRAPHIC_MATERIAS` below). Distinct from `_other` (which is the long
 * tail of legitimate thematic materias outside the top-N) so the inspector
 * surfaces it as its own bucket.
 */
export const UNCLASSIFIED_BUCKET = "_unclassified";

/**
 * Materia values that are actually geographic tags (autonomous community
 * names) rather than thematic subject areas. The BOE materia table mixes
 * geographic + thematic tags; we drop these when bucketing a norm because
 * jurisdiction is already its own axis. A state-level Real Decreto tagged
 * "Cataluña" should not end up filed under materia=Cataluña.
 *
 * Hand-curated to keep filtering deterministic (no fuzzy matching). If we
 * ever miss one, add it here.
 */
export const GEOGRAPHIC_MATERIAS: ReadonlySet<string> = new Set<string>([
	"Andalucía",
	"Aragón",
	"Asturias",
	"Baleares",
	"Illes Balears",
	"Canarias",
	"Cantabria",
	"Castilla-La Mancha",
	"Castilla La Mancha", // pilot 100 had this un-hyphenated form (DB row q_284da20b)
	"Castilla y León",
	"Cataluña",
	"Catalunya",
	"Ceuta",
	"Comunidad Valenciana",
	"Comunitat Valenciana",
	"Extremadura",
	"Galicia",
	"La Rioja",
	"Madrid",
	"Melilla",
	"Murcia",
	"Navarra",
	"País Vasco",
	"Euskadi",
]);

/**
 * Prefix patterns for geographic materias too numerous / variable to
 * enumerate exhaustively. Anything starting with one of these is a
 * jurisdictional/territorial tag, not a thematic subject area:
 *   - "Comunidad Autónoma de [region]"        — generic CCAA prefix
 *   - "Régimen económico de [region]"          — fiscal regime per region
 *   - "Régimen económico fiscal de [region]"   — variant
 */
const GEOGRAPHIC_MATERIA_PREFIXES: readonly string[] = [
	"Comunidad Autónoma de ",
	"Comunidad Autónoma del ",
	"Régimen económico de ",
	"Régimen Económico de ",
	"Régimen económico fiscal de ",
	"Régimen Económico Fiscal de ",
];

/** True if the materia tag is a geographic (autonomous community) value. */
export function isGeographicMateria(materia: string): boolean {
	if (GEOGRAPHIC_MATERIAS.has(materia)) return true;
	for (const prefix of GEOGRAPHIC_MATERIA_PREFIXES) {
		if (materia.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Multiplicative boosts applied to the per-cell raw weight in `computeQuotas`,
 * keyed by exact materia name. Real citizen pain ≠ corpus density: the BOE
 * tags hundreds of small administrative norms with materias like
 * "Asistencia social" or "Comunidades Autónomas", which inflates their cell
 * counts and crowds out the materias citizens actually need help with
 * (employment, housing, taxes…). The boosts re-weight the quota table so
 * those high-pain materias get proportionally more seats — and a few
 * administrative-heavy ones get fewer — without touching the candidate pool
 * itself.
 *
 * Anything not in the map is treated as 1.0× (no change).
 */
export const MATERIA_BOOSTS: ReadonlyMap<string, number> = new Map<
	string,
	number
>([
	// ↑ Citizen-pain materias (multiply the density-derived weight). Names
	// must match BOE's exact materia tags — these are the ones citizens
	// actually call us about: jobs, housing, taxes, immigration, traffic.
	["Trabajadores", 2.0],
	["Trabajo", 2.0],
	["Trabajadores autónomos", 2.0],
	["Contratos de trabajo", 2.0],
	["Estatuto de los Trabajadores", 2.0],
	["Seguridad Social", 1.5],
	["Seguridad e higiene en el trabajo", 1.5],
	["Viviendas", 2.0],
	["Viviendas de Protección Oficial", 2.0],
	["Arrendamientos urbanos", 2.0],
	["Extranjeros", 2.0],
	["Tráfico", 2.0],
	["Consumidores y usuarios", 1.5],
	["Impuesto sobre la Renta de las Personas Físicas", 2.0],
	["Impuesto sobre el Valor Añadido", 2.0],
	["Impuesto sobre Sucesiones y Donaciones", 1.5],
	["Impuesto sobre Bienes Inmuebles", 1.5],
	// ↓ Administrative-heavy materias that dominate the corpus by count but
	// rarely surface in citizen questions.
	["Asistencia social", 0.7],
	["Autorizaciones", 0.7],
	["Comunidades Autónomas", 0.7],
	["Organización de las Comunidades Autónomas", 0.5],
	["Organización de la Administración del Estado", 0.7],
	["Formularios administrativos", 0.5],
	["Registros administrativos", 0.7],
]);

/**
 * Materias that must keep their own bucket even when they fall outside the
 * top-N most common materias by corpus count. Without this, low-volume but
 * high-citizen-pain materias (Vivienda, Arrendamientos urbanos, Extranjeros,
 * IVA, Trabajo, …) get collapsed into `_other`, where the materia boost
 * cannot reach them anymore. The strata loader unions this set with the
 * top-N set when deciding what stays its own cell vs goes to `_other`.
 */
export const ALWAYS_KEEP_MATERIAS: ReadonlySet<string> = new Set<string>([
	"Trabajo",
	"Trabajadores autónomos",
	"Contratos de trabajo",
	"Estatuto de los Trabajadores",
	"Seguridad e higiene en el trabajo",
	"Viviendas",
	"Viviendas de Protección Oficial",
	"Arrendamientos urbanos",
	"Extranjeros",
	"Inversiones extranjeras",
	"Tráfico",
	"Impuesto sobre el Valor Añadido",
	"Impuesto sobre Sucesiones y Donaciones",
	"Impuesto sobre Bienes Inmuebles",
	"Impuesto sobre Transmisiones Patrimoniales y Actos Jurídicos Documentados",
	"Impuesto sobre el Patrimonio",
	"Accidentes de trabajo y enfermedades profesionales",
	"Inspección de Trabajo y Seguridad Social",
]);

/** Look up the multiplicative weight boost for a materia (defaults to 1.0). */
export function materiaBoost(materia: string): number {
	return MATERIA_BOOSTS.get(materia) ?? 1.0;
}

export function cellKey(c: CellKey): string {
	return `${c.materia}|${c.jurisdiction}|${c.rank}|${c.decade}`;
}

export function parseCellKey(k: string): CellKey {
	const [materia, jurisdiction, rank, decade] = k.split("|");
	return {
		materia: materia ?? "",
		jurisdiction: jurisdiction ?? "",
		rank: rank ?? "",
		decade: decade ?? "",
	};
}

/**
 * Compute target seed counts per cell from raw eligibility counts.
 * Pure function — no DB access — so it is easy to unit-test or inspect.
 */
export function computeQuotas(input: QuotaInputs): QuotaResult {
	const budget = input.budget ?? DEFAULT_BUDGET;
	const min = input.min ?? DEFAULT_MIN;
	const max = input.max ?? DEFAULT_MAX;
	const alpha = input.alpha ?? DEFAULT_ALPHA;
	const floor = input.materiaDecadeFloor ?? DEFAULT_MATERIA_DECADE_FLOOR;

	const totalArticles = Array.from(input.cellCounts.values()).reduce(
		(a, b) => a + b,
		0,
	);
	if (totalArticles === 0) {
		return { targets: new Map(), totalTarget: 0 };
	}

	// Step 1: raw weights ∝ density^alpha × materiaBoost, capped at `max`
	// per cell. The materia boost expresses the gap between corpus density
	// and citizen pain (see `MATERIA_BOOSTS`).
	const rawWeights = new Map<string, number>();
	let weightSum = 0;
	for (const [k, count] of input.cellCounts) {
		if (count <= 0) continue;
		const density = count / totalArticles;
		const c = parseCellKey(k);
		const w = density ** alpha * materiaBoost(c.materia);
		rawWeights.set(k, w);
		weightSum += w;
	}

	// Step 2: scale to budget, then clamp.
	const targets = new Map<string, number>();
	for (const [k, w] of rawWeights) {
		const eligible = input.cellCounts.get(k) ?? 0;
		const raw = (w / weightSum) * budget;
		const clamped = Math.max(min, Math.min(max, Math.round(raw)));
		// Never request more seeds than the cell can supply.
		targets.set(k, Math.min(clamped, eligible));
	}

	// Step 3: enforce (materia × decade) floor.
	if (floor > 0) {
		const mdAggregate = new Map<string, number>();
		for (const [k, t] of targets) {
			const c = parseCellKey(k);
			const md = `${c.materia}|${c.decade}`;
			mdAggregate.set(md, (mdAggregate.get(md) ?? 0) + t);
		}
		for (const [md, total] of mdAggregate) {
			if (total >= floor) continue;
			// Distribute the missing seeds across populated cells of this (materia,decade).
			const need = floor - total;
			const candidates = Array.from(targets.entries()).filter(([k]) => {
				const c = parseCellKey(k);
				return `${c.materia}|${c.decade}` === md;
			});
			if (candidates.length === 0) continue;
			let added = 0;
			let i = 0;
			while (added < need) {
				const [k, t] = candidates[i % candidates.length]!;
				const eligible = input.cellCounts.get(k) ?? 0;
				if (t < Math.min(max, eligible)) {
					targets.set(k, t + 1);
					added += 1;
				} else if (
					candidates.every(([kk]) => {
						const eg = input.cellCounts.get(kk) ?? 0;
						return (targets.get(kk) ?? 0) >= Math.min(max, eg);
					})
				) {
					break;
				}
				i += 1;
			}
		}
	}

	const totalTarget = Array.from(targets.values()).reduce((a, b) => a + b, 0);
	return { targets, totalTarget };
}
