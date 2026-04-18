/**
 * RAG Pipeline Tracing — Opik observability integration.
 *
 * Provides full traceability for the RAG pipeline:
 * - Each /v1/ask call becomes a trace
 * - Each pipeline stage (analysis, retrieval, synthesis, verification) becomes a span
 * - Captures input/output/metadata at every stage
 *
 * Disabled gracefully when OPIK_API_KEY is not set (no-op in development).
 */

import { Opik, type Span, type SpanType, type Trace } from "opik";

// ── Client singleton ──

let client: Opik | null = null;

function getClient(): Opik | null {
	if (client) return client;

	const apiKey = process.env.OPIK_API_KEY;
	const apiUrl = process.env.OPIK_URL_OVERRIDE;

	if (!apiKey && !apiUrl) return null;

	try {
		client = new Opik({
			...(apiKey ? { apiKey } : {}),
			...(apiUrl ? { apiUrl } : {}),
			projectName: process.env.OPIK_PROJECT ?? "leyabierta-rag",
		});
		console.log(
			`[tracing] Opik initialized (project: ${process.env.OPIK_PROJECT ?? "leyabierta-rag"})`,
		);
		return client;
	} catch (err) {
		console.warn("[tracing] Failed to initialize Opik:", err);
		return null;
	}
}

// ── Public API ──

export interface RagTrace {
	/** Create a child span for a pipeline stage */
	span(name: string, type: SpanType, input: Record<string, unknown>): RagSpan;
	/** End the trace with final output */
	end(output: Record<string, unknown>): void;
	/** Add a quality score to the trace */
	score(name: string, value: number, reason?: string): void;
}

export interface RagSpan {
	/** End the span with output and metadata */
	end(
		output: Record<string, unknown>,
		metadata?: Record<string, unknown>,
	): void;
}

/**
 * Start a new trace for a RAG pipeline invocation.
 * Returns a no-op trace if Opik is not configured.
 */
export function startTrace(
	question: string,
	metadata?: Record<string, unknown>,
): RagTrace {
	const opik = getClient();
	if (!opik) return NO_OP_TRACE;

	const trace = opik.trace({
		name: "rag-pipeline",
		input: { question },
		metadata,
		tags: ["rag", "production"],
	});

	return new OpikRagTrace(trace);
}

/**
 * Flush all pending traces. Call on server shutdown.
 */
export async function flushTraces(): Promise<void> {
	if (client) {
		await client.flush();
	}
}

// ── Implementation ──

class OpikRagTrace implements RagTrace {
	constructor(private trace: Trace) {}

	span(name: string, type: SpanType, input: Record<string, unknown>): RagSpan {
		const span = this.trace.span({ name, type, input });
		return new OpikRagSpan(span);
	}

	end(output: Record<string, unknown>): void {
		this.trace.update({ output });
		this.trace.end();
	}

	score(name: string, value: number, reason?: string): void {
		this.trace.score({ name, value, reason });
	}
}

class OpikRagSpan implements RagSpan {
	constructor(private span: Span) {}

	end(
		output: Record<string, unknown>,
		metadata?: Record<string, unknown>,
	): void {
		this.span.update({ output, ...(metadata ? { metadata } : {}) });
		this.span.end();
	}
}

// ── No-op fallback (when Opik is not configured) ──

const NO_OP_SPAN: RagSpan = {
	end: () => {},
};

const NO_OP_TRACE: RagTrace = {
	span: () => NO_OP_SPAN,
	end: () => {},
	score: () => {},
};
