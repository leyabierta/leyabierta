/**
 * Memoized `/openapi.json` document builder.
 *
 * The swagger plugin (`@elysiajs/swagger`) computes the OpenAPI document
 * inside its own `/swagger/json` route handler, which isn't exported — the
 * only way to reach it is an HTTP-shaped call into the same Elysia app
 * (`app.handle(new Request(...))`). That self-call re-enters the app's own
 * life-cycle hooks, including the per-IP rate limiter in `index.ts`.
 *
 * A naive `/openapi.json` handler that does this self-call on EVERY request
 * has a real bug (found in PR #209 review): the synthetic internal request
 * has no `CF-Connecting-IP`, so `getClientIp()` buckets it under a single
 * shared `"unknown"` key — every caller of `/openapi.json`, from every real
 * IP, feeds the *same* counter. Once that shared bucket trips the limiter,
 * the inner call returns a 429 body, but the outer handler (which never
 * copied the inner response's status) still answers **200** with that 429
 * body — a 200 that lies about what happened, exactly what an agent-facing
 * endpoint must not do.
 *
 * The fix: do the self-call/build ONCE, memoize the result, and serve the
 * cached document to every subsequent request — no repeated self-call, so
 * nothing to trip on the "unknown" bucket after the first request. (Belt and
 * braces: `index.ts` also exempts `/openapi.json` and `/swagger/json` from
 * the rate limiter outright, since it's a cheap, static, cacheable document —
 * see the comment there.)
 *
 * `build()` also runs `enrichOpenApiDoc` (openapi-schemas.ts) over the
 * document the swagger plugin produced, adding the shared `ErrorResponse`
 * component and per-operation response schemas. That's a pure, in-memory
 * transform of the JSON document — it never touches request validation, so
 * it can't turn a real response into a runtime 500 the way Elysia's
 * `response:` route option would.
 */

import { enrichOpenApiDoc } from "./openapi-schemas.ts";

export interface OpenApiDoc {
	/** GET /openapi.json: status + JSON body to send as-is. */
	get(): Promise<{ status: number; body: unknown }>;
}

/**
 * @param fetchSpec Fetches the underlying OpenAPI document (e.g. a
 *   self-call to `/swagger/json`). Called at most once per successful build —
 *   concurrent callers before the first success share one in-flight promise.
 * @param log Called with a message when a build fails, before returning the
 *   error response to the client (never the raw error to the client itself).
 */
export function createOpenApiDoc(
	fetchSpec: () => Promise<Response>,
	log: (message: string) => void = (m) => console.error(m),
): OpenApiDoc {
	let cached: unknown | null = null;
	let pending: Promise<unknown> | null = null;

	async function build(): Promise<unknown> {
		const res = await fetchSpec();
		if (!res.ok) {
			throw new Error(`OpenAPI document source responded HTTP ${res.status}`);
		}
		return enrichOpenApiDoc(await res.json());
	}

	return {
		async get() {
			if (cached !== null) return { status: 200, body: cached };
			if (!pending) {
				pending = build().catch((err) => {
					// Don't wedge every future request on one transient failure —
					// the next call gets to try again.
					pending = null;
					throw err;
				});
			}
			try {
				const body = await pending;
				cached = body;
				return { status: 200, body };
			} catch (err) {
				log(
					`[openapi.json] failed to build the document: ${
						err instanceof Error ? (err.stack ?? err.message) : String(err)
					}`,
				);
				return {
					status: 500,
					body: {
						error: "Could not build the OpenAPI document",
						code: "OPENAPI_BUILD_FAILED",
					},
				};
			}
		},
	};
}
