/**
 * Privacy routing preferences sent with every OpenRouter request (chat,
 * embeddings, rerank). Citizens' questions can contain personal data, so:
 *
 *   - `zdr: true` — only route to endpoints with Zero Data Retention
 *     (https://openrouter.ai/docs/guides/features/zdr). The OpenRouter account
 *     also enforces ZDR in its privacy settings; this per-request flag keeps
 *     the guarantee if that account setting is ever relaxed by mistake.
 *   - `data_collection: "deny"` — never route to providers that may store or
 *     train on inputs.
 *   - `ignore: ["siliconflow"]` — SiliconFlow (Singapore) is a ZDR-listed
 *     provider for qwen/qwen3-embedding-8b, but its privacy policy names no
 *     GDPR transfer mechanism. Excluding it keeps question embeddings on
 *     DeepInfra (US) or Nebius (NL). It also only serves an fp8 build, so
 *     excluding it keeps query vectors closer to the stored corpus vectors.
 *
 * Set OPENROUTER_ZDR=false to send no preferences (research/eval only — e.g.
 * to A/B a model that has no ZDR endpoint). Under the account-level ZDR
 * setting such models still return 404.
 *
 * Lives in the pipeline package so the daily cron's per-article summaries
 * (ai/article-summary.ts) send exactly the same field;
 * packages/api/src/services/openrouter.ts re-exports both functions.
 */
export function openRouterPrivacyRouting(
	env: Record<string, string | undefined> = process.env,
):
	| { zdr: true; data_collection: "deny"; ignore: string[] }
	| Record<string, never> {
	if ((env.OPENROUTER_ZDR ?? "").trim().toLowerCase() === "false") return {};
	return { zdr: true, data_collection: "deny", ignore: ["siliconflow"] };
}

/** Request-body fragment: `{ provider: {...} }`, or `{}` when disabled. */
export function openRouterProviderField(
	env: Record<string, string | undefined> = process.env,
): { provider?: ReturnType<typeof openRouterPrivacyRouting> } {
	const prefs = openRouterPrivacyRouting(env);
	return Object.keys(prefs).length > 0 ? { provider: prefs } : {};
}
