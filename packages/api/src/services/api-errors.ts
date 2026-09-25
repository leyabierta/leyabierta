/**
 * Structured JSON errors for framework-level failures.
 *
 * Elysia's built-in error responses (unmatched route, schema validation,
 * unhandled throw) are plain text (`"NOT_FOUND"`) by default, which agent
 * readiness scanners flag — an agent parsing a 404 body as JSON gets a parse
 * error instead of a machine-readable reason. `structuredError` computes the
 * status + `{ error, code, hint }` body for Elysia's `onError` life-cycle
 * codes; wire it in with:
 *
 *   app.onError(({ code, error, path, set }) => {
 *     const { status, body } = structuredError(code, error, path);
 *     set.status = status;
 *     return body;
 *   });
 *
 * It only covers thrown/framework errors. Route handlers that set
 * `set.status` and `return {...}` directly — the large majority in
 * `routes/*.ts`, including the documented ask-quota 429 shape
 * (`{ error, reason, retryAfterSeconds, ... }`) — never reach `onError`, so
 * their existing JSON bodies are untouched by this.
 *
 * (Kept as a plain function of primitives, not an Elysia `onError` handler
 * directly: typing the full Elysia error-context object here fights the
 * framework's own generic inference and is unnecessary — the logic only
 * needs `code`, `error` and `path`.)
 */

export const OPENAPI_HINT =
	"See https://api.leyabierta.es/openapi.json for the full API reference.";

export interface StructuredError {
	error: string;
	code: string;
	hint?: string;
}

export function structuredError(
	code: number | string,
	error: unknown,
	path: string,
): { status: number; body: StructuredError } {
	switch (code) {
		case "NOT_FOUND":
			return {
				status: 404,
				body: {
					error: `No route found at ${path}`,
					code: "NOT_FOUND",
					hint: OPENAPI_HINT,
				},
			};
		case "VALIDATION":
			return {
				status: 422,
				body: {
					error:
						error instanceof Error && error.message
							? error.message
							: "Request parameters failed validation",
					code: "VALIDATION_ERROR",
					hint: OPENAPI_HINT,
				},
			};
		case "PARSE":
			return {
				status: 400,
				body: {
					error: "Could not parse the request body",
					code: "PARSE_ERROR",
					hint: OPENAPI_HINT,
				},
			};
		case "INTERNAL_SERVER_ERROR":
			return {
				status: 500,
				body: { error: "Internal server error", code: "INTERNAL_ERROR" },
			};
		default: {
			// INVALID_COOKIE_SIGNATURE and any future/unknown Elysia error code.
			const status =
				typeof (error as { status?: unknown })?.status === "number"
					? (error as { status: number }).status
					: 500;
			return {
				status,
				body: {
					error: status >= 500 ? "Internal server error" : "Request error",
					code: "UNKNOWN_ERROR",
				},
			};
		}
	}
}

/** The structured error as a Response. onError must return a Response, not
 *  the plain object: with a mapResponse hook registered, Elysia 1.4 drops an
 *  object returned from onError for NOT_FOUND and answers 404 with an empty
 *  body. `headers` carries whatever the request already set (CORS, security
 *  headers); the content type is always JSON. */
export function errorResponse(
	status: number,
	body: StructuredError,
	headers: Record<string, string | number | undefined>,
): Response {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		if (v !== undefined) out[k] = String(v);
	}
	out["Content-Type"] = "application/json; charset=utf-8";
	return new Response(JSON.stringify(body), { status, headers: out });
}
