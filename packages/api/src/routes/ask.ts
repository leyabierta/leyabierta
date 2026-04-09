/**
 * RAG Q&A endpoint — citizens ask questions about their rights.
 */

import { Elysia, t } from "elysia";
import type { RagPipeline } from "../services/rag/pipeline.ts";

export function askRoutes(pipeline: RagPipeline | null) {
	return new Elysia({ prefix: "/v1" }).post(
		"/ask",
		async ({ body, set }) => {
			if (!pipeline) {
				set.status = 503;
				return {
					error:
						"El servicio de preguntas no está disponible. Falta OPENROUTER_API_KEY.",
				};
			}

			const question = body.question?.trim();
			if (!question || question.length < 3) {
				set.status = 400;
				return { error: "La pregunta debe tener al menos 3 caracteres." };
			}
			if (question.length > 1000) {
				set.status = 400;
				return { error: "La pregunta es demasiado larga (máximo 1000 caracteres)." };
			}

			try {
				const result = await pipeline.ask({ question });

				// No cache for AI-generated responses
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
			body: t.Object({
				question: t.String(),
			}),
			detail: {
				summary: "Ask a question about Spanish legislation",
				description:
					"Send a question in plain language and receive an answer grounded in real legislative articles with verifiable citations.",
				tags: ["Preguntas"],
			},
		},
	);
}
