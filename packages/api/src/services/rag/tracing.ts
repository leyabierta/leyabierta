/**
 * RAG Pipeline Tracing — Opik observability integration.
 *
 * Provides full traceability for the RAG pipeline:
 * - Each /v1/ask call becomes a trace
 * - Each pipeline stage (analysis, retrieval, synthesis, verification) becomes a span
 * - Captures input/output/metadata at every stage
 *
 * ROBUSTNESS: Every Opik SDK call is wrapped in try-catch. A tracing failure
 * must NEVER break the RAG pipeline or user response. If Opik is down or
 * misconfigured, the pipeline runs identically — just without traces.
 *
 * Disabled gracefully when OPIK_API_KEY is not set (no-op in development).
 */

import { Opik, type Span, type SpanType, type Trace } from "opik";

// ── Client singleton ──

let client: Opik | null = null;
let initAttempted = false;

function getClient(): Opik | null {
	if (client) return client;
	if (initAttempted) return null;
	initAttempted = true;

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

function safeCall(fn: () => void, context: string): void {
	try {
		fn();
	} catch (err) {
		console.warn(`[tracing] ${context} failed:`, err);
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
 * Returns a no-op trace if Opik is not configured or initialization fails.
 */
export function startTrace(
	question: string,
	metadata?: Record<string, unknown>,
): RagTrace {
	const opik = getClient();
	if (!opik) return NO_OP_TRACE;

	try {
		const trace = opik.trace({
			name: "rag-pipeline",
			input: { question },
			metadata,
			tags: ["rag", "production"],
		});
		return new OpikRagTrace(trace);
	} catch (err) {
		console.warn("[tracing] Failed to create trace:", err);
		return NO_OP_TRACE;
	}
}

/**
 * Start a new trace for a hybrid search invocation (/v1/laws).
 * Uses the same Opik project as the RAG pipeline (`leyabierta-rag`) so
 * both search paths are visible in a single UI view. Differentiated by
 * trace name (`hybrid-laws-search`).
 *
 * Returns a no-op trace if Opik is not configured or initialization fails.
 */
export function startHybridTrace(
	query: string,
	metadata?: Record<string, unknown>,
): RagTrace {
	const opik = getClient();
	if (!opik) return NO_OP_TRACE;

	try {
		const trace = opik.trace({
			name: "hybrid-laws-search",
			input: { query },
			metadata,
			tags: ["hybrid-search", "production"],
		});
		return new OpikRagTrace(trace);
	} catch (err) {
		console.warn("[tracing] Failed to create hybrid trace:", err);
		return NO_OP_TRACE;
	}
}

/**
 * Flush all pending traces. Call on server shutdown.
 * Safe to call even if Opik was never initialized.
 */
export async function flushTraces(): Promise<void> {
	if (!client) return;
	try {
		await client.flush();
	} catch (err) {
		console.warn("[tracing] Flush failed:", err);
	}
}

// ── Implementation ──

class OpikRagTrace implements RagTrace {
	constructor(private trace: Trace) {}

	span(name: string, type: SpanType, input: Record<string, unknown>): RagSpan {
		try {
			const span = this.trace.span({ name, type, input });
			return new OpikRagSpan(span);
		} catch (err) {
			console.warn(`[tracing] Failed to create span '${name}':`, err);
			return NO_OP_SPAN;
		}
	}

	end(output: Record<string, unknown>): void {
		safeCall(() => {
			this.trace.update({ output });
			this.trace.end();
		}, "trace.end");
	}

	score(name: string, value: number, reason?: string): void {
		safeCall(
			() => this.trace.score({ name, value, reason }),
			`trace.score(${name})`,
		);
	}
}

class OpikRagSpan implements RagSpan {
	constructor(private span: Span) {}

	end(
		output: Record<string, unknown>,
		metadata?: Record<string, unknown>,
	): void {
		safeCall(() => {
			this.span.update({ output, ...(metadata ? { metadata } : {}) });
			this.span.end();
		}, "span.end");
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
