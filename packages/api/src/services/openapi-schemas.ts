/**
 * Documentation-only response schemas for `/openapi.json`.
 *
 * Elysia's `response:` route option performs RUNTIME validation — a real
 * response that drifts even slightly from the declared shape becomes a 500
 * in production. That is never used here. Instead, this module builds a
 * plain OpenAPI Responses Object per operation and `enrichOpenApiDoc`
 * (called once, in `openapi-doc.ts`, after the swagger plugin has already
 * built the document) merges it into the already-generated spec. Nothing
 * about request handling changes; this only affects the JSON document
 * served at `/openapi.json`.
 *
 * Schemas are hand-derived from the actual route handlers (`routes/*.ts`)
 * and cross-checked against real production responses
 * (`curl https://api.leyabierta.es/v1/...`) — not from the TypeScript
 * interfaces alone, which sometimes lag the real SELECTed columns (e.g.
 * `LawRow.jurisdiction`: present on every real response, added to the SQL
 * projection after the interface was written).
 */

type JsonSchema = Record<string, unknown>;

/**
 * Shared error body. `code`/`hint` are only present on framework-level
 * errors that go through the global `onError` (`services/api-errors.ts`) —
 * unmatched route, schema validation, unhandled throw. Most route handlers
 * (the large majority in `routes/*.ts`) set `set.status` and return
 * `{ error }` directly and never reach `onError`, so those bodies have no
 * `code`/`hint` — confirmed against a real 404
 * (`curl https://api.leyabierta.es/v1/laws/BOE-A-9999-99999` →
 * `{"error":"Law not found"}`, no `code`) vs. a real unmatched-route 404
 * (`{"error":"...","code":"NOT_FOUND","hint":"..."}`). Marking `code`/`hint`
 * required would misdescribe the majority of real error bodies.
 */
export const ERROR_RESPONSE_SCHEMA: JsonSchema = {
	type: "object",
	required: ["error"],
	properties: {
		error: {
			type: "string",
			description:
				"Human-readable error message (Spanish or English, not machine-parseable).",
		},
		code: {
			type: "string",
			description:
				"Machine-readable error code. Only present on framework-level errors (unmatched route, validation, internal error) — see services/api-errors.ts.",
		},
		hint: {
			type: "string",
			description:
				"Pointer to further documentation. Only present alongside `code`.",
		},
	},
	additionalProperties: true,
};

const ERROR_REF = { $ref: "#/components/schemas/ErrorResponse" };

function jsonContent(schema: JsonSchema): {
	"application/json": { schema: JsonSchema };
} {
	return { "application/json": { schema } };
}

function errorEntry(description: string): {
	description: string;
	content: unknown;
} {
	return { description, content: jsonContent(ERROR_REF) };
}

function okEntry(
	description: string,
	schema: JsonSchema,
): { description: string; content: unknown } {
	return { description, content: jsonContent(schema) };
}

// ── Reusable field fragments (kept in sync with services/db.ts + real responses) ──

const lawSummarySchema: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", example: "BOE-A-1978-31229" },
		title: { type: "string" },
		short_title: { type: "string" },
		country: { type: "string", example: "es" },
		jurisdiction: { type: "string", example: "es" },
		rank: { type: "string", example: "ley" },
		published_at: { type: "string", format: "date" },
		updated_at: { type: "string", format: "date", nullable: true },
		status: { type: "string", enum: ["vigente", "derogada"] },
		department: { type: "string" },
		source_url: { type: "string", format: "uri" },
		citizen_summary: { type: "string" },
	},
};

const blockSchema: JsonSchema = {
	type: "object",
	properties: {
		block_id: { type: "string", example: "a1" },
		block_type: { type: "string", example: "precepto" },
		title: { type: "string" },
		position: { type: "integer" },
		current_text: { type: "string" },
		citizen_summary: { type: "string", nullable: true },
	},
};

const reformSchema: JsonSchema = {
	type: "object",
	properties: {
		norm_id: { type: "string" },
		date: { type: "string", format: "date" },
		source_id: { type: "string" },
		affected_blocks: { type: "array", items: { type: "string" } },
	},
};

const namedCountSchema = (nameField: string): JsonSchema => ({
	type: "object",
	properties: {
		[nameField]: { type: "string" },
		count: { type: "integer" },
	},
});

const changelogReformSchema: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		title: { type: "string" },
		rank: { type: "string" },
		status: { type: "string" },
		date: { type: "string", format: "date" },
		source_id: { type: "string" },
		headline: { type: "string", nullable: true },
		summary: { type: "string", nullable: true },
		reform_type: { type: "string", nullable: true },
		importance: { type: "string", nullable: true },
		materia_count: { type: "integer" },
		omnibus_topic_count: { type: "integer" },
	},
};

// ── Per-operation responses (keyed "METHOD /openapi/path") ──
//
// Only the codes each handler can actually produce are listed; a catch-all
// 429/5XX is added to every operation by `enrichOpenApiDoc` itself, so it is
// not repeated here.

export const RESPONSE_SCHEMAS: Record<
	string,
	Record<string, { description: string; content?: unknown }>
> = {
	"GET /v1/laws": {
		"200": okEntry("Matching laws, paginated.", {
			type: "object",
			properties: {
				data: { type: "array", items: lawSummarySchema },
				total: { type: "integer" },
				limit: { type: "integer" },
				offset: { type: "integer" },
				capped: {
					type: "boolean",
					description:
						"true when the underlying count was capped for performance.",
				},
			},
		}),
		"503": errorEntry(
			"Hybrid search unavailable (OPENROUTER_API_KEY not configured, or the embedding/vector backend failed).",
		),
	},
	"GET /v1/laws/{id}": {
		"200": okEntry("Full law: metadata, reforms, citizen tags, and blocks.", {
			allOf: [
				lawSummarySchema,
				{
					type: "object",
					properties: {
						citizen_tags: { type: "array", items: { type: "string" } },
						reforms: { type: "array", items: reformSchema },
						blocks: { type: "array", items: blockSchema },
					},
				},
			],
		}),
		"404": errorEntry("No law with this id."),
	},
	"GET /v1/laws/{id}/summaries": {
		"200": okEntry(
			"Map of article title → citizen summary (only articles with a summary today).",
			{
				type: "object",
				additionalProperties: { type: "string" },
				example: {
					"Artículo 1": "España es un Estado social y democrático de Derecho…",
				},
			},
		),
		"404": errorEntry("No law with this id."),
	},
	"GET /v1/laws/{id}/history": {
		"200": okEntry("Reform timeline with affected block titles.", {
			type: "object",
			properties: {
				id: { type: "string" },
				title: { type: "string" },
				total_reforms: { type: "integer" },
				reforms: {
					type: "array",
					items: {
						type: "object",
						properties: {
							date: { type: "string", format: "date" },
							source_id: { type: "string" },
							affected_blocks: {
								type: "array",
								items: {
									type: "object",
									properties: {
										block_id: { type: "string" },
										title: { type: "string" },
									},
								},
							},
						},
					},
				},
			},
		}),
		"404": errorEntry("No law with this id."),
	},
	"GET /v1/laws/{id}/versions/{date}": {
		"200": okEntry("Markdown content of the law as of the given date.", {
			type: "object",
			properties: {
				id: { type: "string" },
				date: { type: "string", format: "date" },
				content: {
					type: "string",
					description: "Full Markdown text at that date.",
				},
			},
		}),
		"400": errorEntry("Invalid date format (must be YYYY-MM-DD)."),
		"404": errorEntry("No law with this id, or no version at this date."),
	},
	"GET /v1/laws/{id}/markdown": {
		"200": {
			description: "Current canonical Markdown (frontmatter + text).",
			content: { "text/markdown": { schema: { type: "string" } } },
		},
		"404": {
			description: "No law with this id, or no Markdown available.",
			content: { "text/plain": { schema: { type: "string" } } },
		},
	},
	"GET /v1/laws/{id}/diff": {
		"200": okEntry("Unified diff between the two dates.", {
			type: "object",
			properties: {
				id: { type: "string" },
				from: { type: "string", format: "date" },
				to: { type: "string", format: "date" },
				diff: {
					type: "string",
					description: "Unified diff text (git diff format).",
				},
			},
		}),
		"400": errorEntry("Missing or invalid 'from'/'to' query params."),
		"404": errorEntry(
			"No law with this id, or no diff computable for these dates.",
		),
	},
	"GET /v1/laws/{id}/analisis": {
		"200": okEntry("Materias, notas, and cross-references.", {
			type: "object",
			properties: {
				id: { type: "string" },
				materias: { type: "array", items: { type: "string" } },
				notas: { type: "array", items: { type: "string" } },
				referencias: {
					type: "object",
					properties: {
						anteriores: {
							type: "array",
							items: {
								type: "object",
								properties: {
									relation: { type: "string" },
									normId: { type: "string" },
									text: { type: "string" },
								},
							},
						},
						posteriores: {
							type: "array",
							items: {
								type: "object",
								properties: {
									relation: { type: "string" },
									normId: { type: "string" },
									text: { type: "string" },
								},
							},
						},
					},
				},
			},
		}),
		"404": errorEntry("No law with this id."),
	},
	"GET /v1/laws/{id}/graph": {
		"200": okEntry("Relationship graph nodes and edges for the law.", {
			type: "object",
			properties: {
				nodes: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							title: { type: "string" },
							rank: { type: "string" },
						},
					},
				},
				edges: { type: "array", items: {} },
			},
		}),
		"404": errorEntry("No law with this id."),
	},
	"GET /v1/ranks": {
		"200": okEntry("Rank types with law counts.", {
			type: "object",
			properties: { data: { type: "array", items: namedCountSchema("rank") } },
		}),
	},
	"GET /v1/materias": {
		"200": okEntry("Subject categories with law counts.", {
			type: "object",
			properties: {
				data: { type: "array", items: namedCountSchema("materia") },
			},
		}),
	},
	"GET /v1/citizen-tags": {
		"200": okEntry("Citizen-friendly tag categories with law counts.", {
			type: "object",
			properties: {
				data: { type: "array", items: namedCountSchema("tag") },
			},
		}),
	},
	"GET /v1/stats": {
		"200": okEntry(
			"Aggregate statistics: total laws, articles, versions, reforms, categories, and date range.",
			{
				type: "object",
				properties: {
					norms: { type: "integer" },
					articles: { type: "integer" },
					versions: { type: "integer" },
					reforms: { type: "integer" },
					categories: { type: "integer" },
					oldest: { type: "string", format: "date" },
					newest: { type: "string", format: "date" },
				},
			},
		),
	},
	"GET /v1/most-reformed": {
		"200": okEntry("The 10 most frequently reformed laws.", {
			type: "object",
			properties: {
				data: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							title: { type: "string" },
							rank: { type: "string" },
							reform_count: { type: "integer" },
							published_at: { type: "string", format: "date" },
						},
					},
				},
			},
		}),
	},
	"GET /v1/jurisdictions": {
		"200": okEntry(
			"All jurisdictions (state + autonomous communities) with law counts.",
			{
				type: "object",
				properties: {
					data: { type: "array", items: namedCountSchema("jurisdiction") },
				},
			},
		),
	},
	"GET /v1/recent-reforms": {
		"200": okEntry("The 10 most recently reformed laws.", {
			type: "object",
			properties: {
				data: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							title: { type: "string" },
							last_reform: { type: "string", format: "date" },
							citizen_summary: { type: "string", nullable: true },
						},
					},
				},
			},
		}),
	},
	"GET /v1/reforms/{normId}/{date}": {
		"200": okEntry(
			"Full detail for a specific reform of a law, with navigation to adjacent reforms.",
			{
				type: "object",
				properties: {
					law: {
						type: "object",
						properties: {
							id: { type: "string" },
							title: { type: "string" },
							short_title: { type: "string" },
							rank: { type: "string" },
							status: { type: "string" },
							source_url: { type: "string", format: "uri" },
							last_reform_date: {
								type: "string",
								format: "date",
								nullable: true,
							},
						},
					},
					reform: reformSchema,
					affected_blocks: { type: "array", items: { type: "string" } },
					prev_reform_date: { type: "string", format: "date", nullable: true },
					next_reform_date: { type: "string", format: "date", nullable: true },
					source_url: { type: "string", format: "uri" },
				},
			},
		),
		"404": errorEntry("No reform of this law on this date."),
	},
	"GET /og/{id}": {
		"200": {
			description: "The pre-generated Open Graph share image for this law.",
			content: {
				"image/png": { schema: { type: "string", format: "binary" } },
			},
		},
		"400": errorEntry("Missing id."),
		"404": errorEntry(
			"No OG image for this id (not yet generated, or the id doesn't exist).",
		),
	},
	"GET /v1/changelog": {
		"200": okEntry("Recent reforms with AI summaries, newest first.", {
			type: "object",
			properties: {
				reforms: { type: "array", items: changelogReformSchema },
				date_range: { type: "string", example: "2026-08-28 to 2026-09-25" },
				weeks: {
					type: "integer",
					description: "Window actually applied (clamped to <= 12).",
				},
				weeks_requested: { type: "integer" },
				weeks_clamped: { type: "boolean" },
				limit: { type: "integer" },
				offset: { type: "integer" },
				has_more: { type: "boolean" },
			},
		}),
		"400": errorEntry(
			"Invalid weeks/limit/offset, or the unsupported 'since' param was used.",
		),
	},
	"GET /v1/reforms/personal": {
		"200": okEntry(
			"Reforms filtered by the caller's materias and jurisdiction.",
			{
				type: "object",
				properties: {
					reforms: {
						type: "array",
						items: {
							allOf: [
								changelogReformSchema,
								{
									type: "object",
									properties: {
										match_ratio: { type: "number" },
										matched_topics: { type: "array", items: {} },
									},
								},
							],
						},
					},
					materias: { type: "array", items: { type: "string" } },
					limit: { type: "integer" },
					offset: { type: "integer" },
				},
			},
		),
		"400": errorEntry(
			"Missing/invalid materias, jurisdiction, limit, or offset.",
		),
	},
	"GET /v1/omnibus": {
		"200": okEntry("Recent omnibus laws with topic counts.", {
			type: "object",
			properties: {
				data: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							title: { type: "string" },
							rank: { type: "string" },
							materia_count: { type: "integer" },
							topic_count: { type: "integer" },
							sneaked_count: { type: "integer" },
							latest_reform_date: { type: "string", format: "date" },
						},
					},
				},
			},
		}),
	},
	"GET /v1/omnibus/{normId}": {
		"200": okEntry("Omnibus law detail with per-topic AI breakdowns.", {
			type: "object",
			properties: {
				topics: { type: "array", items: { type: "object" } },
				sneaked_count: { type: "integer" },
			},
			additionalProperties: true,
		}),
		"404": errorEntry("No norm with this id, or it is not an omnibus law."),
	},
	"GET /v1/status": {
		"200": okEntry("Corpus freshness.", {
			type: "object",
			properties: {
				norms_count: { type: "integer" },
				reforms_count: { type: "integer" },
				corpus_max_published_at: { type: "string", format: "date" },
				last_reform_date: { type: "string", format: "date", nullable: true },
				days_since_last_reform: { type: "integer", nullable: true },
				last_sync: { type: "string", nullable: true },
				last_sync_source: { type: "string", nullable: true },
			},
		}),
	},
	"POST /v1/ask": {
		"200": okEntry(
			"Cited, plain-language answer grounded in the retrieved articles.",
			{
				type: "object",
				properties: {
					answer: { type: "string" },
					citations: {
						type: "array",
						items: {
							type: "object",
							properties: {
								normId: { type: "string" },
								normTitle: { type: "string" },
								articleTitle: { type: "string" },
								anchor: { type: "string" },
								blockId: { type: "string" },
								citizenSummary: { type: "string" },
								verified: { type: "boolean" },
							},
						},
					},
					declined: { type: "boolean" },
					tldr: { type: "string" },
					nextQuestions: { type: "array", items: { type: "string" } },
					suggestedQuestions: { type: "array", items: { type: "string" } },
					meta: {
						type: "object",
						properties: {
							articlesRetrieved: { type: "integer" },
							temporalEnriched: { type: "boolean" },
							latencyMs: { type: "integer" },
							model: { type: "string" },
						},
					},
				},
			},
		),
		"400": errorEntry(
			"Question missing, too short (<3 chars), or too long (>1000 chars).",
		),
		"429": {
			description:
				"Request-rate limit (20/min per IP) or the question quota exceeded (2/min, 10/day per IP, 200/day global).",
			content: jsonContent({
				type: "object",
				properties: {
					error: { type: "string" },
					reason: {
						type: "string",
						enum: ["per_minute", "per_day", "global_day"],
					},
					retryAfterSeconds: { type: "integer" },
					remainingToday: { type: "integer" },
					limitPerDay: { type: "integer" },
				},
			}),
		},
		"503": errorEntry(
			"The RAG pipeline is unavailable (OPENROUTER_API_KEY not configured).",
		),
	},
	"POST /v1/ask/stream": {
		"200": {
			description:
				"Server-Sent Events: stage, quota, progress, chunk (repeated), then done — or error. See DEPLOY/CLAUDE.md for the event shapes; SSE bodies aren't representable as a single JSON schema.",
			content: { "text/event-stream": { schema: { type: "string" } } },
		},
		"503": errorEntry(
			"The RAG pipeline is unavailable (OPENROUTER_API_KEY not configured). Sent as an SSE 'error' event, not a plain JSON body.",
		),
	},
	"GET /health": {
		"200": okEntry("API status, build version, and total law count.", {
			type: "object",
			properties: {
				status: { type: "string", example: "ok" },
				version: {
					type: "string",
					description: "Git SHA of the running build, or 'dev'.",
				},
				laws: { type: "integer" },
				last_ingest: { type: "string", format: "date-time", nullable: true },
			},
		}),
	},
};

/**
 * OpenAPI 3.0 requires every response object to carry a `description` (it's
 * the one required field on a Response Object). The swagger plugin doesn't
 * set one on its own `"200": {}` placeholder, which is invalid per the spec
 * (confirmed with `bunx @redocly/cli lint` against the served document) even
 * though most tooling tolerates it silently. Backfill it for any response
 * this module didn't already give one, in English to match the rest of the
 * generated document (operation summaries/descriptions are all English).
 */
function withDescriptions(
	responses: Record<string, unknown>,
	summary: string | undefined,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [code, value] of Object.entries(responses)) {
		if (value && typeof value === "object" && !("description" in value)) {
			const isError = code === "default" || /^[45]/.test(code);
			out[code] = {
				...value,
				description: isError
					? "Error response."
					: summary
						? `${summary} — successful response.`
						: "Successful response.",
			};
		} else {
			out[code] = value;
		}
	}
	return out;
}

/**
 * Merge `ErrorResponse` + the schemas above into an already-built OpenAPI
 * document (as returned by the swagger plugin's `/swagger/json`). Pure
 * function — returns a new object, never mutates `doc`. Documentation only:
 * this never touches how requests are actually validated or handled.
 */
export function enrichOpenApiDoc(doc: unknown): unknown {
	if (!doc || typeof doc !== "object") return doc;
	const source = doc as Record<string, unknown>;
	const components = (source.components as Record<string, unknown>) ?? {};
	const schemas = (components.schemas as Record<string, unknown>) ?? {};

	const paths = { ...((source.paths as Record<string, unknown>) ?? {}) };
	for (const [path, methods] of Object.entries(paths)) {
		if (!methods || typeof methods !== "object") continue;
		const newMethods: Record<string, unknown> = {
			...(methods as Record<string, unknown>),
		};
		for (const [method, op] of Object.entries(
			methods as Record<string, unknown>,
		)) {
			if (!op || typeof op !== "object") continue;
			const operation = op as Record<string, unknown>;
			const key = `${method.toUpperCase()} ${path}`;
			const overrides = RESPONSE_SCHEMAS[key];
			const existingResponses =
				(operation.responses as Record<string, unknown>) ?? {};
			const mergedResponses = {
				...existingResponses,
				...overrides,
				// Every operation can hit the rate limiter (429) or an
				// unhandled error (5XX) — add a catch-all for both unless the
				// operation already declared something more specific for
				// that code.
				"429":
					existingResponses["429"] ??
					overrides?.["429"] ??
					errorEntry("Rate limit exceeded."),
				"5XX":
					existingResponses["5XX"] ??
					overrides?.["5XX"] ??
					errorEntry("Internal server error."),
			};
			newMethods[method] = {
				...operation,
				responses: withDescriptions(
					mergedResponses,
					typeof operation.summary === "string" ? operation.summary : undefined,
				),
			};
		}
		paths[path] = newMethods;
	}

	return {
		...source,
		components: {
			...components,
			schemas: { ...schemas, ErrorResponse: ERROR_RESPONSE_SCHEMA },
		},
		paths,
	};
}
