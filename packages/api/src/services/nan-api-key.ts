/**
 * Resolve the api.nan.builders API key from the environment.
 *
 * Reads `NAN_API_KEY`. Returns `undefined` if unset — callers decide whether
 * that's a hard error (runtime / embed jobs) or acceptable (dry-run tooling).
 */

export function getNanApiKey(): string | undefined {
	return process.env.NAN_API_KEY;
}

/**
 * Same as `getNanApiKey()` but throws when missing. Use from code paths where
 * a missing key is unrecoverable (the runtime RAG pipeline, embed-corpus jobs).
 */
export function requireNanApiKey(): string {
	const key = getNanApiKey();
	if (!key) {
		throw new Error("NAN_API_KEY not set; required for api.nan.builders calls");
	}
	return key;
}
