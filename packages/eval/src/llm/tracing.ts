/**
 * Opik tracing for the eval package.
 *
 * Reuses project `leyabierta-rag` (CLAUDE.md decision). Each LLM call from
 * the eval package becomes a span under a parent trace owned by the caller
 * (one trace per pipeline run, one trace per annotation pass, etc.).
 *
 * Trace name conventions:
 *   - `eval-dataset-gen`     — full agentic generation pipeline
 *   - `eval-judge-panel`     — judge panel deliberation
 *   - `eval-alternative-finder` — alternative-article voting
 *   - `eval-import-annotation` — article-level annotation of human seeds
 *
 * Always safe-to-fail: a tracing error must NEVER break an LLM call.
 */

import { Opik, type Span, type Trace } from "opik";

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
		return client;
	} catch (err) {
		console.warn("[eval/tracing] Opik init failed:", err);
		return null;
	}
}

export interface EvalTrace {
	span(name: string, input: Record<string, unknown>): EvalSpan;
	end(output: Record<string, unknown>): void;
}

export interface EvalSpan {
	end(
		output: Record<string, unknown>,
		metadata?: Record<string, unknown>,
	): void;
}

const NO_OP_SPAN: EvalSpan = { end: () => {} };
const NO_OP_TRACE: EvalTrace = {
	span: () => NO_OP_SPAN,
	end: () => {},
};

class OpikEvalSpan implements EvalSpan {
	constructor(private span: Span) {}
	end(output: Record<string, unknown>, metadata?: Record<string, unknown>) {
		try {
			this.span.update({ output, ...(metadata ? { metadata } : {}) });
			this.span.end();
		} catch (err) {
			console.warn("[eval/tracing] span.end failed:", err);
		}
	}
}

class OpikEvalTrace implements EvalTrace {
	constructor(private trace: Trace) {}
	span(name: string, input: Record<string, unknown>): EvalSpan {
		try {
			return new OpikEvalSpan(this.trace.span({ name, type: "llm", input }));
		} catch (err) {
			console.warn(`[eval/tracing] span '${name}' failed:`, err);
			return NO_OP_SPAN;
		}
	}
	end(output: Record<string, unknown>) {
		try {
			this.trace.update({ output });
			this.trace.end();
		} catch (err) {
			console.warn("[eval/tracing] trace.end failed:", err);
		}
	}
}

export function startEvalTrace(
	name: string,
	input: Record<string, unknown>,
	tags: string[] = ["eval"],
): EvalTrace {
	const opik = getClient();
	if (!opik) return NO_OP_TRACE;
	try {
		return new OpikEvalTrace(opik.trace({ name, input, tags }));
	} catch (err) {
		console.warn(`[eval/tracing] trace '${name}' failed:`, err);
		return NO_OP_TRACE;
	}
}

export async function flushEvalTraces(): Promise<void> {
	if (!client) return;
	try {
		await client.flush();
	} catch (err) {
		console.warn("[eval/tracing] flush failed:", err);
	}
}
