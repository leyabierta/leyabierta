/**
 * Bill Parser — shared utilities (quote ranges, section boundaries, deduplication).
 */

import type { ModificationGroup } from "./types.ts";

// ── Quote range detection ──

/**
 * Build sorted list of [start, end] ranges for «...» quoted blocks.
 * Text inside «» is proposed law text, not bill structure — any headers
 * found inside (e.g., "Disposición adicional séptima") are NOT real sections.
 */
export function buildQuotedRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let searchFrom = 0;
	while (true) {
		const open = text.indexOf("«", searchFrom);
		if (open === -1) break;
		const close = text.indexOf("»", open + 1);
		if (close === -1) break;
		ranges.push([open, close]);
		searchFrom = close + 1;
	}
	return ranges;
}

/** Check if a character index falls inside any «...» quoted block. */
export function isInsideQuotedBlock(
	index: number,
	quotedRanges: Array<[number, number]>,
): boolean {
	// Binary search would be faster but linear is fine for typical bill sizes
	for (const [start, end] of quotedRanges) {
		if (index > start && index < end) return true;
		if (start > index) break; // ranges are sorted, no point continuing
	}
	return false;
}

// ── Section boundary finder ──

export function findSectionBoundaries(text: string): number[] {
	const boundaryRegex =
		/\n(?:Artículo [\p{L}\d]+\.|Disposición (?:final|transitoria|derogatoria|adicional) [\p{L}\d]+\.)/gu;
	const boundaries: number[] = [];
	for (const match of text.matchAll(boundaryRegex)) {
		boundaries.push(match.index!);
	}
	boundaries.push(text.length);
	return boundaries;
}

// ── Group deduplication ──

/** Remove duplicate groups that target the same law with overlapping modifications */
export function deduplicateGroups(
	groups: ModificationGroup[],
): ModificationGroup[] {
	const seen = new Map<string, number>(); // key → index of first occurrence
	const result: ModificationGroup[] = [];

	for (const group of groups) {
		// Create a dedup key from the first 50 chars of target law + first mod target
		const firstMod = group.modifications[0]?.targetProvision ?? "";
		const key = `${group.targetLaw.slice(0, 50).toLowerCase()}|${firstMod.slice(0, 30).toLowerCase()}`;

		if (seen.has(key)) {
			// Keep the one with more modifications (or longer target law name)
			const existingIdx = seen.get(key)!;
			if (
				group.modifications.length >
					result[existingIdx]!.modifications.length ||
				(group.modifications.length ===
					result[existingIdx]!.modifications.length &&
					group.targetLaw.length > result[existingIdx]!.targetLaw.length)
			) {
				result[existingIdx] = group;
			}
		} else {
			seen.set(key, result.length);
			result.push(group);
		}
	}

	return result;
}
