/**
 * AskChat — React island for the /pregunta page.
 *
 * Citizens ask legal questions and get answers grounded in real articles.
 * Supports multi-turn conversation with scrollable history.
 * Uses SSE streaming for real-time text display.
 */

import MarkdownIt from "markdown-it";
import { type ReactNode, useEffect, useRef, useState } from "react";

// ── Markdown renderer ──
// `html: false` means raw HTML inside the markdown is escaped — Gemini output
// is trusted but we still keep the guard. `linkify: false` so we don't
// auto-link random URLs (the rendered text is already very citation-heavy).
const md = new MarkdownIt({ html: false, breaks: true, linkify: false });

interface Citation {
	normId: string;
	normTitle: string;
	articleTitle: string;
	/** Predictable HTML anchor ID (e.g. "articulo-90") for deep-linking */
	anchor?: string;
	citizenSummary?: string;
	verified?: boolean;
}

interface AskMeta {
	articlesRetrieved: number;
	temporalEnriched: boolean;
	latencyMs: number;
	model: string;
}

interface AskResponse {
	answer: string;
	citations: Citation[];
	declined: boolean;
	meta: AskMeta;
}

type ProgressStep = "analyzing" | "retrieving" | "ranking" | "writing";

const PROGRESS_ORDER: ProgressStep[] = [
	"analyzing",
	"retrieving",
	"ranking",
	"writing",
];

const PROGRESS_LABELS: Record<ProgressStep, string> = {
	analyzing: "Analizando tu pregunta",
	retrieving: "Buscando artículos relevantes",
	ranking: "Seleccionando las fuentes más fiables",
	writing: "Redactando la respuesta",
};

interface Turn {
	question: string;
	response: AskResponse | null;
	error: string | null;
	currentStep?: ProgressStep;
}

const API_BASE =
	typeof document !== "undefined"
		? (document.documentElement.dataset.api ?? "https://api.leyabierta.es")
		: "https://api.leyabierta.es";

const EXAMPLE_QUESTIONS = [
	"¿Cuántos días de vacaciones me corresponden por ley?",
	"¿Me pueden despedir estando embarazada?",
	"¿Cuánto preaviso tiene que dar mi casero para subir el alquiler?",
	"¿Qué derechos tengo si me venden un producto defectuoso?",
];

// ── Citation parsing ──

const CITE_PATTERN =
	/\[([A-Z]{2,5}-[A-Za-z]-\d{4}-\d+),\s*(Art(?:ículo|\.)\s*\d+(?:\.\d+)?(?:\s*(?:bis|ter|quater|quinquies|sexies|septies))?[^[\]]*?)\]/g;

function buildCitationMap(
	citations: Citation[],
): Map<string, Map<string, Citation>> {
	const map = new Map<string, Map<string, Citation>>();
	for (const c of citations) {
		if (!map.has(c.normId)) map.set(c.normId, new Map());
		map.get(c.normId)!.set(c.articleTitle.toLowerCase(), c);
	}
	return map;
}

/**
 * Render a plain text run, splitting out citation matches and replacing them
 * with interactive React links + tooltips. Used both for the markdown path
 * (per text-node) and as a fallback during SSR / pre-hydration.
 */
function renderTextWithCitations(
	text: string,
	citationMap: Map<string, Map<string, Citation>>,
	keyPrefix: string,
): ReactNode[] {
	const parts: ReactNode[] = [];
	let lastIndex = 0;
	let matchIdx = 0;

	for (const match of text.matchAll(CITE_PATTERN)) {
		const start = match.index;
		if (start > lastIndex) {
			parts.push(text.slice(lastIndex, start));
		}

		const normId = match[1]!;
		const articleRef = match[2]!;
		const fullMatch = match[0];
		const citationByArticle = citationMap.get(normId);
		const citation =
			citationByArticle?.get(articleRef.toLowerCase()) ??
			[...(citationByArticle?.values() ?? [])][0];

		if (citation) {
			parts.push(
				<span
					key={`${keyPrefix}-cite-${matchIdx}`}
					className="ask-cite-wrapper"
				>
					<a
						href={`/laws/${normId}/${citation.anchor ? `#${citation.anchor}` : ""}`}
						target="_blank"
						rel="noopener noreferrer"
						className={`ask-cite-link${citation.verified === false ? " ask-cite-approx" : ""}`}
						title={
							citation.verified === false ? "Referencia aproximada" : undefined
						}
					>
						{articleRef}
						<svg
							className="ask-cite-icon"
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
							<polyline points="15 3 21 3 21 9" />
							<line x1="10" y1="14" x2="21" y2="3" />
						</svg>
					</a>
					<span className="ask-cite-tooltip" role="tooltip">
						<span className="ask-cite-tooltip-norm">
							{citation.normTitle || normId}
						</span>
						<span className="ask-cite-tooltip-article">
							{citation.articleTitle}
						</span>
						{citation.citizenSummary && (
							<span className="ask-cite-tooltip-summary">
								{citation.citizenSummary}
							</span>
						)}
						<span className="ask-cite-tooltip-action">Ver en Ley Abierta</span>
					</span>
				</span>,
			);
		} else {
			parts.push(fullMatch);
		}

		lastIndex = start + fullMatch.length;
		matchIdx++;
	}

	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return parts;
}

/**
 * Convert a DOM node tree (from markdown-it output, parsed via DOMParser) into
 * a React element tree. Text nodes go through `renderTextWithCitations` so the
 * `[BOE-A-XXXX-XXXX, Artículo N]` patterns become tooltipped links even when
 * they appear inside list items, paragraphs, headings, etc.
 */
function domToReact(
	node: Node,
	citationMap: Map<string, Map<string, Citation>>,
	keyPrefix: string,
): ReactNode {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.nodeValue ?? "";
		if (!text) return null;
		const rendered = renderTextWithCitations(text, citationMap, keyPrefix);
		// Single string fragment: return as-is (React handles it fine).
		if (rendered.length === 1 && typeof rendered[0] === "string") {
			return rendered[0];
		}
		return <>{rendered}</>;
	}

	if (node.nodeType !== Node.ELEMENT_NODE) return null;

	const el = node as Element;
	const tag = el.tagName.toLowerCase();

	// Skip <script>/<style> defensively (markdown-it shouldn't emit these
	// with `html: false` but belt-and-braces).
	if (tag === "script" || tag === "style") return null;

	const children: ReactNode[] = [];
	for (let i = 0; i < el.childNodes.length; i++) {
		const child = el.childNodes[i];
		if (!child) continue;
		const rendered = domToReact(child, citationMap, `${keyPrefix}-${i}`);
		if (rendered !== null && rendered !== undefined) children.push(rendered);
	}

	const props: Record<string, unknown> = { key: keyPrefix };

	// Carry over href on links (markdown-it can still emit links from auto-
	// detected URLs even with linkify off — be safe).
	if (tag === "a") {
		const href = el.getAttribute("href");
		if (href) {
			props.href = href;
			props.target = "_blank";
			props.rel = "noopener noreferrer";
		}
	}

	// Self-closing tags
	if (tag === "br") return <br key={keyPrefix} />;
	if (tag === "hr") return <hr key={keyPrefix} />;

	// Allow-list of structural tags markdown-it produces. Anything outside
	// this set falls back to <span>.
	const allowed = new Set([
		"p",
		"strong",
		"em",
		"ul",
		"ol",
		"li",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"code",
		"pre",
		"blockquote",
		"a",
		"br",
		"hr",
		"del",
		"s",
		"span",
		"div",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
	]);
	const safeTag = allowed.has(tag) ? tag : "span";

	// biome-ignore lint/suspicious/noExplicitAny: dynamic tag name needs cast for React.createElement equivalent
	const Tag = safeTag as any;
	return (
		<Tag {...props} key={keyPrefix}>
			{children.length > 0 ? children : null}
		</Tag>
	);
}

function renderAnswerWithCitations(
	text: string,
	citations: Citation[],
	streaming = false,
): ReactNode {
	const citationMap = buildCitationMap(citations);

	// During streaming, skip the expensive markdown parse + DOMParser round-trip.
	// Citations aren't available yet (they arrive with the `done` event), so we
	// just render plain paragraphs split by newline.
	if (streaming) {
		return (
			<>
				{text.split("\n").map((line, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: streaming lines have no stable ID
					<p key={i} className="ask-answer-paragraph">
						{line}
					</p>
				))}
			</>
		);
	}

	// SSR / no DOMParser (shouldn't happen in this island, but be defensive):
	// render as a single paragraph with citation replacement only.
	if (typeof DOMParser === "undefined") {
		return (
			<p className="ask-answer-paragraph">
				{renderTextWithCitations(text, citationMap, "ssr")}
			</p>
		);
	}

	const html = md.render(text);
	const doc = new DOMParser().parseFromString(
		`<div>${html}</div>`,
		"text/html",
	);
	const root = doc.body.firstElementChild;
	if (!root) return null;

	const children: ReactNode[] = [];
	for (let i = 0; i < root.childNodes.length; i++) {
		const child = root.childNodes[i];
		if (!child) continue;
		const rendered = domToReact(child, citationMap, `md-${i}`);
		if (rendered !== null && rendered !== undefined) children.push(rendered);
	}
	return <>{children}</>;
}

// ── SSE parsing ──

async function* parseSSE(
	response: Response,
): AsyncGenerator<{ event: string; data: string }> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const events = buffer.split("\n\n");
		buffer = events.pop()!;

		for (const eventStr of events) {
			if (!eventStr.trim()) continue;
			const lines = eventStr.split("\n");
			let event = "message";
			let data = "";
			for (const line of lines) {
				if (line.startsWith("event: ")) event = line.slice(7);
				if (line.startsWith("data: ")) data = line.slice(6);
			}
			yield { event, data };
		}
	}
}

// ── Component ──

const STORAGE_KEY = "leyabierta_ask_history";

function loadTurns(): Turn[] {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		/* ignore */
	}
	return [];
}

function saveTurns(turns: Turn[]) {
	try {
		const completed = turns.filter((t) => t.response || t.error).slice(-20);
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(completed));
	} catch {
		/* ignore */
	}
}

// ── Progress stepper ──

function StepIcon({
	step,
	state,
}: {
	step: ProgressStep;
	state: "done" | "active" | "pending";
}) {
	if (state === "done") {
		return (
			<svg
				className="ask-step-icon ask-step-icon-done"
				width="22"
				height="22"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<polyline points="20 6 9 17 4 12" />
			</svg>
		);
	}

	const animClass = state === "active" ? " ask-step-anim" : "";

	if (step === "analyzing") {
		// Magnifying glass with a soft pulse on the lens.
		return (
			<svg
				className={`ask-step-icon ask-step-icon-analyzing${animClass}`}
				width="22"
				height="22"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<circle cx="11" cy="11" r="7" className="ask-step-lens" />
				<line x1="21" y1="21" x2="16.65" y2="16.65" />
			</svg>
		);
	}

	if (step === "retrieving") {
		// Stack of three documents that gently shift up/down.
		return (
			<svg
				className={`ask-step-icon ask-step-icon-retrieving${animClass}`}
				width="22"
				height="22"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<rect
					x="6"
					y="3"
					width="12"
					height="14"
					rx="1.5"
					className="ask-doc ask-doc-1"
				/>
				<rect
					x="6"
					y="5"
					width="12"
					height="14"
					rx="1.5"
					className="ask-doc ask-doc-2"
				/>
				<rect
					x="6"
					y="7"
					width="12"
					height="14"
					rx="1.5"
					className="ask-doc ask-doc-3"
				/>
			</svg>
		);
	}

	if (step === "ranking") {
		// Three bars that scale vertically at staggered phases.
		return (
			<svg
				className={`ask-step-icon ask-step-icon-ranking${animClass}`}
				width="22"
				height="22"
				viewBox="0 0 24 24"
				fill="currentColor"
				stroke="none"
				aria-hidden="true"
			>
				<rect
					x="4"
					y="14"
					width="4"
					height="6"
					rx="1"
					className="ask-bar ask-bar-1"
				/>
				<rect
					x="10"
					y="10"
					width="4"
					height="10"
					rx="1"
					className="ask-bar ask-bar-2"
				/>
				<rect
					x="16"
					y="6"
					width="4"
					height="14"
					rx="1"
					className="ask-bar ask-bar-3"
				/>
			</svg>
		);
	}

	// writing — pen + a blinking underline cursor.
	return (
		<svg
			className={`ask-step-icon ask-step-icon-writing${animClass}`}
			width="22"
			height="22"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M16 3l5 5-11 11H5v-5L16 3z" />
			<line
				x1="5"
				y1="22"
				x2="14"
				y2="22"
				className="ask-cursor"
				strokeWidth="2.5"
			/>
		</svg>
	);
}

function AskProgressStepper({ current }: { current: ProgressStep }) {
	const currentIdx = PROGRESS_ORDER.indexOf(current);
	return (
		<div
			className="ask-progress-stepper"
			role="status"
			aria-live="polite"
			aria-label="Progreso de la respuesta"
		>
			<ol className="ask-progress-list">
				{PROGRESS_ORDER.map((step, idx) => {
					const state =
						idx < currentIdx
							? "done"
							: idx === currentIdx
								? "active"
								: "pending";
					return (
						<li
							key={step}
							className={`ask-progress-item ask-progress-${state}`}
						>
							<span className="ask-progress-icon-wrap" aria-hidden="true">
								<StepIcon step={step} state={state} />
							</span>
							<span className="ask-progress-label">
								{PROGRESS_LABELS[step]}
							</span>
						</li>
					);
				})}
			</ol>
		</div>
	);
}

export default function AskChat() {
	const [turns, setTurns] = useState<Turn[]>(loadTurns);
	const [question, setQuestion] = useState("");
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		saveTurns(turns);
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [turns]);

	useEffect(() => {
		return () => {
			abortRef.current?.abort();
		};
	}, []);

	async function handleSubmit(q?: string) {
		const text = (q ?? question).trim();
		if (!text || text.length < 3 || loading) return;

		const turnIndex = turns.length;
		setTurns((prev) => [
			...prev,
			{ question: text, response: null, error: null },
		]);
		setQuestion("");
		setLoading(true);

		try {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			const res = await fetch(`${API_BASE}/v1/ask/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: text }),
				signal: controller.signal,
			});

			if (res.status === 429) {
				setTurns((prev) => {
					const updated = [...prev];
					updated[turnIndex] = {
						...updated[turnIndex],
						error:
							"Has hecho demasiadas preguntas. Espera un minuto e inténtalo de nuevo.",
					};
					return updated;
				});
				return;
			}
			if (!res.ok || !res.body) {
				setTurns((prev) => {
					const updated = [...prev];
					updated[turnIndex] = {
						...updated[turnIndex],
						error: "Ha ocurrido un error. Inténtalo de nuevo.",
					};
					return updated;
				});
				return;
			}

			// Initialize partial response for streaming
			let accumulated = "";
			setTurns((prev) => {
				const updated = [...prev];
				updated[turnIndex] = {
					...updated[turnIndex],
					response: {
						answer: "",
						citations: [],
						declined: false,
						meta: {
							articlesRetrieved: 0,
							temporalEnriched: false,
							latencyMs: 0,
							model: "",
						},
					},
				};
				return updated;
			});

			// Throttle re-renders via requestAnimationFrame
			let pendingText = "";
			let rafId: number | null = null;

			function flushText() {
				if (!pendingText) return;
				accumulated += pendingText;
				const snapshot = accumulated;
				pendingText = "";
				setTurns((prev) => {
					const updated = [...prev];
					const turn = updated[turnIndex];
					if (turn?.response) {
						updated[turnIndex] = {
							...turn,
							response: { ...turn.response, answer: snapshot },
						};
					}
					return updated;
				});
			}

			for await (const sseEvent of parseSSE(res)) {
				if (sseEvent.event === "progress") {
					try {
						const progress = JSON.parse(sseEvent.data) as {
							step: ProgressStep;
							label?: string;
						};
						if (PROGRESS_ORDER.includes(progress.step)) {
							setTurns((prev) => {
								const updated = [...prev];
								const turn = updated[turnIndex];
								if (turn) {
									updated[turnIndex] = {
										...turn,
										currentStep: progress.step,
									};
								}
								return updated;
							});
						}
					} catch {
						/* ignore malformed progress events */
					}
				} else if (sseEvent.event === "chunk") {
					pendingText += JSON.parse(sseEvent.data) as string;
					if (!rafId) {
						rafId = requestAnimationFrame(() => {
							flushText();
							rafId = null;
						});
					}
				} else if (sseEvent.event === "done") {
					if (rafId) {
						cancelAnimationFrame(rafId);
						rafId = null;
					}
					flushText();

					const done = JSON.parse(sseEvent.data) as {
						citations: Citation[];
						meta: AskMeta;
						declined: boolean;
					};
					setTurns((prev) => {
						const updated = [...prev];
						const turn = updated[turnIndex];
						if (turn?.response) {
							updated[turnIndex] = {
								...turn,
								response: {
									answer: accumulated,
									citations: done.citations,
									declined: done.declined,
									meta: done.meta,
								},
							};
						}
						return updated;
					});
				} else if (sseEvent.event === "error") {
					const err = JSON.parse(sseEvent.data) as { error: string };
					setTurns((prev) => {
						const updated = [...prev];
						updated[turnIndex] = {
							...updated[turnIndex],
							response: null,
							error: err.error,
						};
						return updated;
					});
				}
			}
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				// Expected on unmount or new submit — don't show error.
				return;
			}
			setTurns((prev) => {
				const updated = [...prev];
				updated[turnIndex] = {
					...updated[turnIndex],
					error:
						"No se ha podido conectar con el servidor. Comprueba tu conexión.",
				};
				return updated;
			});
		} finally {
			setLoading(false);
			inputRef.current?.focus();
		}
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	}

	function handleExample(q: string) {
		handleSubmit(q);
	}

	function handleReset() {
		setTurns([]);
		setQuestion("");
		sessionStorage.removeItem(STORAGE_KEY);
		inputRef.current?.focus();
	}

	const hasHistory = turns.length > 0;
	const lastTurn = turns.at(-1);
	const showStepper = loading && !lastTurn?.response?.answer;

	return (
		<div className="ask-chat">
			<div className="ask-disclaimer" role="status">
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="8" x2="12" y2="12" />
					<line x1="12" y1="16" x2="12.01" y2="16" />
				</svg>
				<span>
					Esta información es orientativa y no constituye asesoramiento
					jurídico. Para tu caso concreto, consulta con un profesional del
					derecho.
				</span>
			</div>

			{!hasHistory && !loading && (
				<div className="ask-examples">
					<p className="ask-examples-label">
						Prueba con una de estas preguntas:
					</p>
					<div className="ask-examples-grid">
						{EXAMPLE_QUESTIONS.map((q) => (
							<button
								key={q}
								type="button"
								className="ask-example-btn"
								onClick={() => handleExample(q)}
							>
								{q}
							</button>
						))}
					</div>
				</div>
			)}

			{hasHistory && (
				<div className="ask-conversation">
					{turns.map((turn, turnIdx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: turns have no stable ID
						<div key={turnIdx} className="ask-turn">
							<div className="ask-turn-question">
								<span className="ask-turn-label">Tu pregunta</span>
								<p>{turn.question}</p>
							</div>

							{turn.response && (
								<div className="ask-turn-answer">
									{turn.response.declined ? (
										<p className="ask-declined">
											{turn.response.answer ||
												"Esta pregunta no está relacionada con la legislación española."}
										</p>
									) : (
										<>
											<div className="ask-answer-text">
												{renderAnswerWithCitations(
													turn.response.answer,
													turn.response.citations,
													loading && turn === lastTurn,
												)}
											</div>

											{turn.response.citations.length > 0 && (
												<div className="ask-turn-citations">
													<p className="ask-turn-citations-label">
														Fuentes citadas:
													</p>
													<ul className="ask-citations-list">
														{turn.response.citations.map((c) => (
															<li
																key={`${c.normId}-${c.articleTitle}`}
																className={`ask-citation-card${c.verified === false ? " ask-citation-approx" : ""}`}
															>
																<a
																	href={`/laws/${c.normId}/${c.anchor ? `#${c.anchor}` : ""}`}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="ask-citation-link"
																>
																	<span className="ask-citation-norm">
																		{c.normId}
																	</span>
																	<span className="ask-citation-article">
																		{c.articleTitle}
																	</span>
																	<svg
																		className="ask-citation-chevron"
																		width="14"
																		height="14"
																		viewBox="0 0 24 24"
																		fill="none"
																		stroke="currentColor"
																		strokeWidth="2"
																		strokeLinecap="round"
																		strokeLinejoin="round"
																		aria-hidden="true"
																	>
																		<polyline points="9 18 15 12 9 6" />
																	</svg>
																</a>
															</li>
														))}
													</ul>
												</div>
											)}

											{turn.response.meta.model && (
												<details className="ask-meta-details">
													<summary className="ask-meta-summary">
														{turn.response.meta.articlesRetrieved} artículos
														consultados en{" "}
														{(turn.response.meta.latencyMs / 1000).toFixed(1)}s
													</summary>
													<div className="ask-meta-content">
														<dl className="ask-meta-list">
															<div className="ask-meta-item">
																<dt>Contexto temporal</dt>
																<dd>
																	{turn.response.meta.temporalEnriched
																		? "Sí (incluye historial de cambios)"
																		: "No"}
																</dd>
															</div>
															<div className="ask-meta-item">
																<dt>Modelo</dt>
																<dd>{turn.response.meta.model}</dd>
															</div>
														</dl>
													</div>
												</details>
											)}
										</>
									)}
								</div>
							)}

							{turn.error && (
								<div className="ask-turn-error">
									<p>{turn.error}</p>
								</div>
							)}
						</div>
					))}

					{showStepper &&
						(lastTurn?.currentStep ? (
							<AskProgressStepper current={lastTurn.currentStep} />
						) : (
							<div className="ask-loading" role="status" aria-live="polite">
								<span className="ask-spinner-large" aria-hidden="true" />
								<p>Buscando en la legislación española...</p>
							</div>
						))}

					<div ref={bottomRef} />
				</div>
			)}

			<div className={`ask-input-area ${hasHistory ? "ask-input-sticky" : ""}`}>
				<label htmlFor="ask-question" className="sr-only">
					Tu pregunta sobre legislación española
				</label>
				<textarea
					ref={inputRef}
					id="ask-question"
					className="ask-textarea"
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={
						hasHistory
							? "Haz otra pregunta..."
							: "Escribe tu pregunta sobre legislación española..."
					}
					rows={hasHistory ? 1 : 2}
					maxLength={1000}
					disabled={loading}
					aria-describedby="ask-hint"
				/>
				<div className="ask-input-footer">
					<span id="ask-hint" className="ask-hint">
						{hasHistory ? (
							<button
								type="button"
								className="ask-reset-btn"
								onClick={handleReset}
							>
								Nueva conversación
							</button>
						) : (
							"Pulsa Enter para enviar"
						)}
					</span>
					<button
						type="button"
						className="btn btn-primary ask-submit"
						onClick={() => handleSubmit()}
						disabled={loading || question.trim().length < 3}
						aria-label="Enviar pregunta"
					>
						{loading ? (
							<span className="ask-spinner" aria-hidden="true" />
						) : (
							<svg
								width="18"
								height="18"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<line x1="22" y1="2" x2="11" y2="13" />
								<polygon points="22 2 15 22 11 13 2 9 22 2" />
							</svg>
						)}
						Preguntar
					</button>
				</div>
			</div>
		</div>
	);
}
