/**
 * Shared date parsing utilities for BOE date formats.
 *
 * BOE uses YYYYMMDD format throughout its API. Sentinel value
 * 99999999 means "no expiry" or "no date". We normalize to
 * ISO 8601 (YYYY-MM-DD) at all boundaries.
 */

/**
 * Parse BOE date format (YYYYMMDD) to ISO date (YYYY-MM-DD).
 * Returns undefined for missing, sentinel (99999999), or invalid values.
 * Already-formatted ISO dates (containing "-") pass through unchanged.
 */
export function parseBoeDate(raw: string | undefined): string | undefined {
	if (!raw || raw === "99999999") return undefined;
	if (raw.includes("-")) return raw;
	if (raw.length >= 8) {
		const year = raw.slice(0, 4);
		const month = raw.slice(4, 6);
		const day = raw.slice(6, 8);
		if (
			Number(year) >= 1800 &&
			Number(month) >= 1 &&
			Number(month) <= 12 &&
			Number(day) >= 1 &&
			Number(day) <= 31
		) {
			return `${year}-${month}-${day}`;
		}
	}
	return undefined;
}
