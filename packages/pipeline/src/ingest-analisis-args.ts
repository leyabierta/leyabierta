/**
 * Argument parsing and norm selection for ingest-analisis-cli.ts.
 * Pure functions, no I/O, so they can be unit-tested without network or DB.
 */

export interface IngestAnalisisArgs {
	dbPath: string;
	concurrency: number;
	jsonDir: string;
	/** Deduped ids from `--ids`, or null when the flag is absent (= all norms). */
	ids: string[] | null;
}

function flagValue(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

/** Parse "A, B,,A" into ["A", "B"]: trimmed, empties dropped, deduped. */
export function parseIds(raw: string | undefined): string[] {
	if (!raw) return [];
	return [
		...new Set(
			raw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
}

/** `argv` is process.argv (node/bun path and script path included). */
export function parseArgs(argv: string[]): IngestAnalisisArgs {
	// A flag in argv[2] (e.g. `bun run ingest-analisis --ids X`) is not a db path.
	const positional = argv[2];
	const dbPath =
		positional && !positional.startsWith("--")
			? positional
			: "./data/leyabierta.db";
	return {
		dbPath,
		concurrency: Number(flagValue(argv, "--concurrency") ?? "6"),
		jsonDir: flagValue(argv, "--json") ?? "./data/json",
		ids: argv.includes("--ids") ? parseIds(flagValue(argv, "--ids")) : null,
	};
}

/**
 * Restrict the norms table rows to the requested ids (all rows when `ids` is
 * null). Unknown ids are returned separately so the caller can log them.
 */
export function selectNorms(
	allNorms: { id: string }[],
	ids: string[] | null,
): { norms: { id: string }[]; unknown: string[] } {
	if (ids === null) return { norms: allNorms, unknown: [] };
	const wanted = new Set(ids);
	const norms = allNorms.filter((n) => wanted.has(n.id));
	const known = new Set(norms.map((n) => n.id));
	return { norms, unknown: ids.filter((id) => !known.has(id)) };
}
