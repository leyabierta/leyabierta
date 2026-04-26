/**
 * Sub-chunking for long articles.
 *
 * Splits articles by numbered apartados (e.g. "1. ...", "2. ...").
 * Each sub-chunk gets its own embedding, improving retrieval for
 * multi-topic articles like ET art.48 (9753 chars, 9 apartados).
 *
 * The split is deterministic: same input → same output. This means
 * we can re-split at retrieval time to extract the right sub-chunk
 * without storing texts separately.
 */

/** Separator between parent blockId and apartado number in sub-chunk IDs. */
export const SUBCHUNK_SEP = "__";

export interface SubChunk {
	/** e.g. "a48__4" */
	blockId: string;
	/** Parent block ID, e.g. "a48" */
	parentBlockId: string;
	/** Synthetic title, e.g. "Artículo 48.4 — El nacimiento, que comprende el parto..." */
	title: string;
	/** Sub-chunk text */
	text: string;
	/** 1-based apartado number */
	apartado: number;
}

/**
 * Split an article's text by numbered apartados.
 * Returns null if the article is short or has no sequential numbered apartados.
 */
export function splitByApartados(
	blockId: string,
	blockTitle: string,
	text: string,
	threshold = 3000,
): SubChunk[] | null {
	if (text.length <= threshold) return null;

	const pattern = /^(\d+)\.\s/gm;
	const matches: Array<{ index: number; num: number }> = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		matches.push({ index: match.index, num: Number.parseInt(match[1]!, 10) });
	}

	if (matches.length < 2 || matches[0]!.num !== 1) return null;

	const sequential: Array<{ index: number; num: number }> = [matches[0]!];
	for (let i = 1; i < matches.length; i++) {
		const last = sequential[sequential.length - 1]!;
		const current = matches[i]!;
		if (current.num === last.num + 1) {
			sequential.push(current);
		}
	}

	if (sequential.length < 2) return null;

	const baseTitle = blockTitle.replace(/\.\s.*$/, "");

	const chunks: SubChunk[] = [];
	for (let i = 0; i < sequential.length; i++) {
		const item = sequential[i]!;
		const nextItem = sequential[i + 1];
		const start = item.index;
		const end = nextItem ? nextItem.index : text.length;
		const chunkText = text.slice(start, end).trim();

		const firstSentence =
			chunkText.replace(/^\d+\.\s*/, "").split(/\.\s/)[0] ?? "";
		const synopsis =
			firstSentence.length > 100
				? `${firstSentence.slice(0, 97)}...`
				: firstSentence;

		chunks.push({
			blockId: `${blockId}${SUBCHUNK_SEP}${item.num}`,
			parentBlockId: blockId,
			title: `${baseTitle}.${item.num} — ${synopsis}`,
			text: chunkText,
			apartado: item.num,
		});
	}

	return chunks;
}

/**
 * Check if a blockId is a sub-chunk ID (contains the separator).
 */
export function isSubchunkId(blockId: string): boolean {
	return blockId.includes(SUBCHUNK_SEP);
}

/**
 * Extract parent blockId and apartado number from a sub-chunk ID.
 * Returns null if not a sub-chunk ID.
 */
export function parseSubchunkId(
	blockId: string,
): { parentBlockId: string; apartado: number } | null {
	const sepIdx = blockId.indexOf(SUBCHUNK_SEP);
	if (sepIdx < 0) return null;
	const apartado = Number.parseInt(
		blockId.slice(sepIdx + SUBCHUNK_SEP.length),
		10,
	);
	if (Number.isNaN(apartado)) return null;
	return { parentBlockId: blockId.slice(0, sepIdx), apartado };
}
