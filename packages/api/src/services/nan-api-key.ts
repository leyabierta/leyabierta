/**
 * Resolve the api.nan.builders API key from the environment.
 *
 * Reads `NAN_API_KEY` (correct name — the provider is nan.builders) with a
 * fallback to `HERMES_API_KEY` (legacy name used during the OpenRouter → NaN
 * migration; predates the rename). The fallback emits a one-time deprecation
 * warning so we can drop it in a follow-up PR once every deployment has set
 * `NAN_API_KEY`.
 *
 * Returns `undefined` if neither is set — callers decide whether that's a hard
 * error (runtime / embed jobs) or acceptable (dry-run tooling).
 */

let warnedAboutHermes = false;

export function getNanApiKey(): string | undefined {
	const nan = process.env.NAN_API_KEY;
	if (nan) return nan;

	const hermes = process.env.HERMES_API_KEY;
	if (hermes) {
		if (!warnedAboutHermes) {
			warnedAboutHermes = true;
			console.warn(
				"[nan] using HERMES_API_KEY for nan.builders auth — rename to NAN_API_KEY (HERMES_API_KEY fallback will be removed)",
			);
		}
		return hermes;
	}

	return undefined;
}

/**
 * Same as `getNanApiKey()` but throws when missing. Use from code paths where
 * a missing key is unrecoverable (the runtime RAG pipeline, embed-corpus jobs).
 */
export function requireNanApiKey(): string {
	const key = getNanApiKey();
	if (!key) {
		throw new Error(
			"NAN_API_KEY not set (HERMES_API_KEY fallback also unset); required for api.nan.builders calls",
		);
	}
	return key;
}
