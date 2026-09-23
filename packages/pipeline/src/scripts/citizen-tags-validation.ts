/**
 * Validation for the law-level LLM output of generate-citizen-tags.ts.
 *
 * Kept in its own module so it can be unit-tested without running the script's
 * top-level CLI/DB code.
 */

export interface LawCitizenMetadata {
	citizen_tags: string[];
	citizen_summary: string;
}

/**
 * Parse and validate the law-level response. Returns null (caller counts it as
 * an error and writes nothing) when the JSON is invalid or the summary is blank.
 *
 * A blank summary must not be persisted: the generator selects norms by
 * `citizen_summary = ''`, so writing "" would re-select the same norm on every
 * run (a paid call per day, forever, always at the head of the newest-first
 * queue) and each pass would also wipe the norm's existing article summaries.
 */
export function parseLawCitizenMetadata(
	raw: string,
): LawCitizenMetadata | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;

	const summary =
		typeof d.citizen_summary === "string" ? d.citizen_summary.trim() : "";
	if (!summary) return null;

	const tags = Array.isArray(d.citizen_tags)
		? d.citizen_tags
				.filter((t): t is string => typeof t === "string")
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
		: [];

	return { citizen_tags: tags, citizen_summary: summary };
}
