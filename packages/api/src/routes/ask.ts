/**
 * RAG Q&A endpoints — citizens ask questions about their rights.
 */

import { Elysia, t } from "elysia";
import type { AskQuota, AskQuotaDecision } from "../services/ask-quota.ts";
import type { RagPipeline } from "../services/rag/pipeline.ts";
import { getQuotaClientIp, hasBypassKey } from "../services/rate-limiter.ts";

const askBody = t.Object({
	question: t.String(),
	jurisdiction: t.Optional(t.String()),
});

function validateQuestion(
	question: string | undefined,
): string | { error: string; status: number } {
	const q = question?.trim();
	if (!q || q.length < 3)
		return {
			error: "La pregunta debe tener al menos 3 caracteres.",
			status: 400,
		};
	if (q.length > 1000)
		return {
			error: "La pregunta es demasiado larga (máximo 1000 caracteres).",
			status: 400,
		};
	return q;
}

export interface AskRoutesOptions {
	/** Question quota; `null` disables it (tests, or no pipeline). */
	quota?: AskQuota | null;
	/** X-API-Key value that skips the quota (operator scripts, evals). */
	bypassKey?: string;
}

type QuotaServer = Parameters<typeof getQuotaClientIp>[1];

/** Quota decision per request, handed from beforeHandle to the handler. */
const quotaDecisions = new WeakMap<Request, AskQuotaDecision>();

export function askRoutes(
	pipeline: RagPipeline | null,
	options: AskRoutesOptions = {},
) {
	const { quota = null, bypassKey = "" } = options;

	/**
	 * Count the question against the quota, or reject it with 429.
	 *
	 * Runs as a route-level beforeHandle, i.e. after body-schema validation
	 * and before the handler, so:
	 *   - requests that will be answered with 4xx/503 (bad body, question too
	 *     short/long, pipeline missing) are NOT counted: they cost nothing;
	 *   - an accepted question IS counted before any LLM call, and stays
	 *     counted even if the answer ends up declined or fails midway. The
	 *     credit was already spent (embedding, analyzer, rerank, part of the
	 *     synthesis), and refunding failures would let a client loop on a
	 *     failing question for free;
	 *   - for /ask/stream the 429 is a plain JSON response, sent before the
	 *     SSE stream is opened.
	 */
	const checkQuota = ({
		body,
		request,
		set,
		server,
	}: {
		body: { question: string };
		request: Request;
		set: { status?: number | string; headers: Record<string, unknown> };
		server: QuotaServer;
	}) => {
		if (!quota || !pipeline) return;
		if (typeof validateQuestion(body.question) !== "string") return;
		if (hasBypassKey(request, bypassKey)) return;

		const decision = quota.consume(getQuotaClientIp(request, server));
		quotaDecisions.set(request, decision);
		set.headers["X-RateLimit-Limit"] = String(decision.limitPerDay);
		set.headers["X-RateLimit-Remaining"] = String(decision.remainingToday);
		if (decision.allowed) return;

		set.status = 429;
		set.headers["Retry-After"] = String(decision.retryAfterSeconds);
		set.headers["Cache-Control"] = "no-store";
		return {
			error: decision.message,
			reason: decision.reason,
			retryAfterSeconds: decision.retryAfterSeconds,
			remainingToday: decision.remainingToday,
			limitPerDay: decision.limitPerDay,
		};
	};

	return new Elysia({ prefix: "/v1" })
		.post(
			"/ask",
			async ({ body, set }) => {
				if (!pipeline) {
					set.status = 503;
					return {
						error:
							"El servicio de preguntas no está disponible. Falta OPENROUTER_API_KEY.",
					};
				}

				const validated = validateQuestion(body.question);
				if (typeof validated !== "string") {
					set.status = validated.status;
					return { error: validated.error };
				}

				try {
					const result = await pipeline.ask({
						question: validated,
						jurisdiction: body.jurisdiction,
					});
					set.headers["Cache-Control"] = "no-store";
					return result;
				} catch (err) {
					console.error("RAG pipeline error:", err);
					set.status = 500;
					return {
						error: "Error procesando la pregunta. Inténtalo de nuevo.",
					};
				}
			},
			{
				body: askBody,
				beforeHandle: checkQuota,
				detail: {
					summary: "Ask a question about Spanish legislation",
					description:
						"Send a question in plain language and receive an answer grounded in real legislative articles with verifiable citations.",
					tags: ["Preguntas"],
				},
			},
		)
		.post(
			"/ask/stream",
			// A plain async function that returns an explicit `Response` wrapping
			// a `ReadableStream`, NOT an `async function*` generator.
			//
			// Elysia's generator/SSE machinery (`createStreamHandler` in
			// `@elysiajs/*`'s adapter) builds its own default `Content-Type` /
			// `Cache-Control` under a *lowercase* header key, while this route
			// used to write `set.headers["Content-Type"]` / `["Cache-Control"]`
			// (capitalized) — a different object key, so both ended up on the
			// wire and were joined by the `Headers` constructor into
			// `Content-Type: text/event-stream, text/plain` and
			// `Cache-Control: no-cache, no-transform, no-cache`. Separately, for
			// a generator handler the framework's global `mapResponse` hook
			// (used here for security headers + the request log line, see
			// `index.ts`) observed a `set` object whose `status` mutation inside
			// the generator body never propagated back — the wire response was
			// correctly 503, but the log line always recorded 200.
			//
			// Building the `Response` by hand avoids both: we control every
			// header key ourselves (lowercase, set once) and `set.status` is a
			// normal synchronous assignment on the shared request-scoped `set`
			// object, exactly like every other non-streaming route.
			async ({ body, set, request }) => {
				// Hint to nginx-style proxies to disable response buffering. Cloudflare
				// reads this and (mostly) flushes immediately. Without it CF Tunnel
				// can hold the response until Content-Length / certain buffer fills.
				const headers: Record<string, string> = {
					"content-type": "text/event-stream",
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				};

				if (!pipeline) {
					set.status = 503;
					return new Response(
						`event: error\ndata: ${JSON.stringify({ error: "El servicio de preguntas no está disponible." })}\n\n`,
						{ status: 503, headers },
					);
				}

				const validated = validateQuestion(body.question);
				if (typeof validated !== "string") {
					set.status = validated.status;
					return new Response(
						`event: error\ndata: ${JSON.stringify({ error: validated.error })}\n\n`,
						{ status: validated.status, headers },
					);
				}

				// Cross-origin clients cannot read X-RateLimit-* without
				// Access-Control-Expose-Headers, so the remaining quota also
				// travels in the stream. Older clients ignore unknown events.
				const decision = quotaDecisions.get(request);

				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						const send = (chunk: string) =>
							controller.enqueue(encoder.encode(chunk));
						try {
							// Emit an immediate stage event so the response status + first
							// byte reach Cloudflare well within its 100s origin-timeout
							// window. Without this, CF returns 524 even though the server
							// is still working on retrieval.
							send(
								`event: stage\ndata: ${JSON.stringify({ stage: "retrieval_started" })}\n\n`,
							);
							if (decision?.allowed) {
								send(
									`event: quota\ndata: ${JSON.stringify({ remainingToday: decision.remainingToday, limitPerDay: decision.limitPerDay })}\n\n`,
								);
							}
							for await (const event of pipeline.askStream({
								question: validated,
								jurisdiction: body.jurisdiction,
							})) {
								if (event.type === "chunk") {
									send(`event: chunk\ndata: ${JSON.stringify(event.text)}\n\n`);
								} else if (event.type === "keepalive") {
									// Real event (not SSE comment) so proxies that filter
									// comments still see byte traffic. Clients ignore unknown
									// event types per the SSE spec.
									send(`event: keepalive\ndata: ${JSON.stringify({})}\n\n`);
								} else if (event.type === "progress") {
									const progressPayload: Record<string, unknown> = {
										step: event.step,
									};
									if ("meta" in event && event.meta !== undefined) {
										progressPayload.meta = event.meta;
									}
									send(
										`event: progress\ndata: ${JSON.stringify(progressPayload)}\n\n`,
									);
								} else {
									send(
										`event: done\ndata: ${JSON.stringify({ citations: event.citations, meta: event.meta, declined: event.declined, tldr: event.tldr, nextQuestions: event.nextQuestions, suggestedQuestions: event.suggestedQuestions })}\n\n`,
									);
								}
							}
						} catch (err) {
							console.error("RAG stream error:", err);
							send(
								`event: error\ndata: ${JSON.stringify({ error: "Error procesando la pregunta." })}\n\n`,
							);
						} finally {
							controller.close();
						}
					},
				});

				set.status = 200;
				return new Response(stream, { status: 200, headers });
			},
			{
				body: askBody,
				beforeHandle: checkQuota,
				detail: {
					summary: "Ask a question (streaming)",
					description:
						"Streaming variant — returns Server-Sent Events with text chunks followed by a final event with citations.",
					tags: ["Preguntas"],
				},
			},
		)
		.post(
			"/_eval/retrieval",
			async ({ body, set, request }) => {
				// Internal eval hook: it spends credit (embedding + analyzer) and
				// sits outside the question quota, so when a bypass key is
				// configured (production) only callers holding it may use it.
				if (bypassKey && !hasBypassKey(request, bypassKey)) {
					set.status = 404;
					return { error: "Not found" };
				}
				if (!pipeline) {
					set.status = 503;
					return { error: "RAG pipeline unavailable." };
				}
				const validated = validateQuestion(body.question);
				if (typeof validated !== "string") {
					set.status = validated.status;
					return { error: validated.error };
				}
				try {
					return await pipeline.evalRetrieval({
						question: validated,
						jurisdiction: body.jurisdiction,
					});
				} catch (err) {
					console.error("eval retrieval error:", err);
					set.status = 500;
					return { error: err instanceof Error ? err.message : String(err) };
				}
			},
			{ body: askBody },
		);
}
