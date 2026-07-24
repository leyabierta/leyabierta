/**
 * Shared helpers for normalizing BOE API JSON shapes.
 *
 * The BOE API (and the raw sumario/diario JSON) collapses a list to a bare
 * object when it has exactly one item, and omits the key entirely when
 * empty. Every consumer that walks these structures needs the same
 * "always an array" normalization.
 */

/** Normalize BOE API values that can be object, array, or empty. */
export function toArray(val: unknown): Record<string, unknown>[] {
	if (Array.isArray(val)) return val as Record<string, unknown>[];
	if (val && typeof val === "object" && Object.keys(val).length > 0)
		return [val as Record<string, unknown>];
	return [];
}
