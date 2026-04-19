/**
 * RAG Q&A endpoints — citizens ask questions about their rights.
 */

import { Elysia, t } from "elysia";
import type { RagPipeline } from "../services/rag/pipeline.ts";

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

export function askRoutes(pipeline: RagPipeline | null) {
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
			async function* ({ body, set }) {
				if (!pipeline) {
					set.status = 503;
					yield `event: error\ndata: ${JSON.stringify({ error: "El servicio de preguntas no está disponible." })}\n\n`;
					return;
				}

				const validated = validateQuestion(body.question);
				if (typeof validated !== "string") {
					set.status = validated.status;
					yield `event: error\ndata: ${JSON.stringify({ error: validated.error })}\n\n`;
					return;
				}

				set.headers["Content-Type"] = "text/event-stream";
				set.headers["Cache-Control"] = "no-store";
				set.headers.Connection = "keep-alive";

				try {
					for await (const event of pipeline.askStream({
						question: validated,
						jurisdiction: body.jurisdiction,
					})) {
						if (event.type === "chunk") {
							yield `event: chunk\ndata: ${JSON.stringify(event.text)}\n\n`;
						} else {
							yield `event: done\ndata: ${JSON.stringify({ citations: event.citations, meta: event.meta, declined: event.declined })}\n\n`;
						}
					}
				} catch (err) {
					console.error("RAG stream error:", err);
					yield `event: error\ndata: ${JSON.stringify({ error: "Error procesando la pregunta." })}\n\n`;
				}
			},
			{
				body: askBody,
				detail: {
					summary: "Ask a question (streaming)",
					description:
						"Streaming variant — returns Server-Sent Events with text chunks followed by a final event with citations.",
					tags: ["Preguntas"],
				},
			},
		);
}
