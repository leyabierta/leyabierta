/**
 * Rebuild a `Norm` from its JSON cache file (`data/json/<id>.json`).
 *
 * Shared by `pipeline rebuild` (cli.ts) and ad-hoc maintenance scripts under
 * scripts/ad-hoc/ that must re-render a norm exactly as the rebuild would.
 * Moved out of cli.ts unchanged so both use the same reconstruction.
 */

import type {
	Block,
	Norm,
	NormAnalisis,
	NormMetadata,
	Paragraph,
	Rank,
	Reform,
	Version,
} from "../models.ts";

/**
 * Infer CSS class from paragraph text when the original class was lost
 * during JSON serialization. Detects common legislative structure patterns.
 */
function inferCssClass(text: string): string {
	const trimmed = text.trim();

	// Structural headings (Spanish legislative conventions)
	if (/^TÍTULO\s/i.test(trimmed) || /^TITULO\s/i.test(trimmed)) return "titulo";
	if (/^CAPÍTULO\s/i.test(trimmed) || /^CAPITULO\s/i.test(trimmed))
		return "capitulo";
	if (/^SECCIÓN\s/i.test(trimmed) || /^SECCION\s/i.test(trimmed))
		return "seccion";
	if (/^SUBSECCIÓN\s/i.test(trimmed) || /^SUBSECCION\s/i.test(trimmed))
		return "subseccion";
	if (/^LIBRO\s/i.test(trimmed)) return "libro";
	if (/^ANEXO/i.test(trimmed)) return "anexo";

	// Article headings
	if (/^Artículo\s+\d/i.test(trimmed) || /^Articulo\s+\d/i.test(trimmed))
		return "articulo";

	// Disposiciones
	if (/^Disposición\s/i.test(trimmed) || /^Disposicion\s/i.test(trimmed))
		return "capitulo";

	// Preámbulo / exposición de motivos
	if (/^PREÁMBULO$/i.test(trimmed) || /^PREAMBULO$/i.test(trimmed))
		return "centro_negrita";
	if (/^EXPOSICIÓN DE MOTIVOS$/i.test(trimmed)) return "centro_negrita";

	return "parrafo";
}

/**
 * Shape of the `metadata` object inside a cached norm JSON file. Declared
 * explicitly rather than as `Record<string, string>`: with
 * `noUncheckedIndexedAccess`, every index access on a Record is `string |
 * undefined`, so the old assertion was quietly lying about ten fields at once.
 */
interface CachedMetadata {
	title: string;
	shortTitle: string;
	id: string;
	country: string;
	rank: string;
	published: string;
	updated: string;
	status: string;
	department: string;
	source: string;
}

/** Shape of one entry in a block's `versions` array in the JSON cache. */
interface CachedVersion {
	sourceId: string;
	date: string;
	text: string;
}

/** Shape of one entry in the `referencias` arrays in the JSON cache. */
interface CachedReference {
	normId: string;
	relation: string;
	text: string;
}

/** Reconstruct a Norm from its cached JSON representation. */
export function jsonToNorm(raw: Record<string, unknown>): Norm {
	const m = raw.metadata as CachedMetadata;
	const metadata: NormMetadata = {
		title: m.title,
		shortTitle: m.shortTitle,
		id: m.id,
		country: m.country,
		rank: m.rank as Rank,
		publishedAt: m.published,
		updatedAt: m.updated,
		status: m.status as NormMetadata["status"],
		department: m.department,
		source: m.source,
	};

	const articles = raw.articles as Array<Record<string, unknown>>;
	const blocks: Block[] = articles.map((a) => ({
		id: a.blockId as string,
		type: a.blockType as string,
		title: a.title as string,
		versions: (a.versions as CachedVersion[]).map(
			(v): Version => ({
				normId: v.sourceId,
				publishedAt: v.date,
				effectiveAt: v.date,
				paragraphs: (v.text ?? "").split("\n\n").map(
					(text): Paragraph => ({
						cssClass: inferCssClass(text),
						text,
					}),
				),
			}),
		),
	}));

	let reforms: Reform[] = (raw.reforms as Array<Record<string, unknown>>).map(
		(r) => ({
			date: r.date as string,
			normId: r.sourceId as string,
			affectedBlockIds: (r.affectedBlocks as string[]) ?? [],
		}),
	);

	// Synthetic bootstrap reform for norms without version history in the BOE XML
	if (reforms.length === 0 && blocks.length > 0) {
		reforms = [
			{
				date: metadata.publishedAt,
				normId: metadata.id,
				affectedBlockIds: blocks.map((b) => b.id),
			},
		];
	}

	// Load analisis if present in enriched JSON cache
	let analisis: NormAnalisis | undefined;
	const rawAnalisis = raw.analisis as Record<string, unknown> | undefined;
	if (rawAnalisis) {
		const refs = rawAnalisis.referencias as
			| Record<string, unknown[]>
			| undefined;
		analisis = {
			materias: (rawAnalisis.materias as string[]) ?? [],
			notas: (rawAnalisis.notas as string[]) ?? [],
			referencias: {
				anteriores: ((refs?.anteriores as CachedReference[]) ?? []).map(
					(r) => ({
						normId: r.normId,
						relation: r.relation,
						text: r.text,
					}),
				),
				posteriores: ((refs?.posteriores as CachedReference[]) ?? []).map(
					(r) => ({
						normId: r.normId,
						relation: r.relation,
						text: r.text,
					}),
				),
			},
		};
	}

	return { metadata, blocks, reforms, analisis };
}
