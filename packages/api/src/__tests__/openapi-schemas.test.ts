/**
 * `enrichOpenApiDoc` (openapi-schemas.ts) — documentation-only response
 * schemas merged onto the swagger plugin's generated `/openapi.json`.
 *
 * Two things must never regress:
 *  - every operation's error responses reference the shared ErrorResponse
 *    component (so a client/agent has one place to learn the error shape);
 *  - the main public endpoints have a real 200 (or equivalent) response
 *    schema, not an empty `{}` (what the swagger plugin emits on its own —
 *    see the comment at the top of openapi-schemas.ts).
 *
 * This never asserts against Elysia's runtime `response:` validation — that
 * option is intentionally never used here (see file header): a schema
 * mismatch in this file can only affect the served JSON document, never turn
 * a real API response into a 500.
 */

import { describe, expect, test } from "bun:test";
import {
	ERROR_RESPONSE_SCHEMA,
	enrichOpenApiDoc,
} from "../services/openapi-schemas.ts";

/** A minimal swagger-plugin-shaped document exercising the cases
 *  `enrichOpenApiDoc` has to handle: an operation with no responses key at
 *  all, one with only an empty "200", and one that already declares its own
 *  "429" (must not be clobbered). */
const RAW_DOC = {
	openapi: "3.0.3",
	info: { title: "Ley Abierta API" },
	components: { schemas: {} },
	paths: {
		"/v1/laws": { get: { operationId: "getV1Laws", responses: { "200": {} } } },
		"/v1/laws/{id}": {
			get: { operationId: "getV1LawsById", responses: { "200": {} } },
		},
		"/health": { get: { operationId: "getHealth", responses: { "200": {} } } },
		"/v1/some-future-endpoint": {
			get: {
				operationId: "getV1SomeFutureEndpoint",
				responses: {
					"200": {},
					"429": { description: "custom rate limit description" },
				},
			},
		},
	},
};

function enriched() {
	return enrichOpenApiDoc(RAW_DOC) as {
		components: { schemas: Record<string, unknown> };
		paths: Record<
			string,
			Record<string, { responses: Record<string, unknown> }>
		>;
	};
}

describe("enrichOpenApiDoc", () => {
	test("registers the shared ErrorResponse component schema", () => {
		const doc = enriched();
		expect(doc.components.schemas.ErrorResponse).toEqual(ERROR_RESPONSE_SCHEMA);
	});

	test("ErrorResponse only requires 'error' — code/hint are optional (route-level errors omit them)", () => {
		expect(ERROR_RESPONSE_SCHEMA.required).toEqual(["error"]);
	});

	test("every operation ends up with at least one response referencing ErrorResponse", () => {
		const doc = enriched();
		for (const methods of Object.values(doc.paths)) {
			for (const op of Object.values(methods)) {
				const referencesError = Object.values(op.responses).some((r) =>
					JSON.stringify(r).includes("#/components/schemas/ErrorResponse"),
				);
				expect(referencesError).toBe(true);
			}
		}
	});

	test("main public endpoints get a real 200 schema, not the empty {} the swagger plugin emits", () => {
		const doc = enriched();
		for (const [path, method] of [
			["/v1/laws", "get"],
			["/v1/laws/{id}", "get"],
			["/health", "get"],
		] as const) {
			const ok = doc.paths[path]?.[method]?.responses["200"] as
				| { content?: unknown }
				| undefined;
			expect(ok?.content).toBeDefined();
		}
	});

	test("every response object gets a 'description' — OpenAPI 3.0 requires it and the swagger plugin doesn't set one", () => {
		const doc = enriched();
		for (const methods of Object.values(doc.paths)) {
			for (const op of Object.values(methods)) {
				for (const resp of Object.values(op.responses)) {
					const description = (resp as { description?: unknown }).description;
					expect(typeof description).toBe("string");
					expect((description as string).length).toBeGreaterThan(0);
				}
			}
		}
	});

	test("backfilled success description falls back to generic text when the operation has no summary", () => {
		const doc = enriched();
		// /v1/some-future-endpoint has no RESPONSE_SCHEMAS override and no
		// `summary` in the RAW_DOC fixture, so its bare "200": {} falls back to
		// the generic text rather than "undefined — successful response.".
		const resp = doc.paths["/v1/some-future-endpoint"]?.get?.responses[
			"200"
		] as { description?: string };
		expect(resp.description).toBe("Successful response.");
	});

	test("backfilled success description uses the operation's summary when present", () => {
		const withSummary = enrichOpenApiDoc({
			openapi: "3.0.3",
			info: { title: "t" },
			paths: {
				"/x": {
					get: { summary: "Do the thing", responses: { "200": {} } },
				},
			},
		}) as {
			paths: Record<
				string,
				{ get: { responses: Record<string, { description?: string }> } }
			>;
		};
		expect(withSummary.paths["/x"]?.get?.responses["200"]?.description).toBe(
			"Do the thing — successful response.",
		);
	});

	test("does not clobber a response code an operation already declared", () => {
		const doc = enriched();
		const custom = doc.paths["/v1/some-future-endpoint"]?.get?.responses[
			"429"
		] as { description?: string };
		expect(custom.description).toBe("custom rate limit description");
	});

	test("is a pure function — never mutates the input document", () => {
		const before = JSON.stringify(RAW_DOC);
		enrichOpenApiDoc(RAW_DOC);
		expect(JSON.stringify(RAW_DOC)).toBe(before);
	});

	test("passes non-object input through unchanged", () => {
		expect(enrichOpenApiDoc(null)).toBe(null);
		expect(enrichOpenApiDoc(undefined)).toBe(undefined);
	});
});
