/**
 * AskChat — React island for the /pregunta page.
 *
 * Citizens ask legal questions and get answers grounded in real articles.
 * Supports multi-turn conversation with scrollable history.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";

interface Citation {
	normId: string;
	normTitle: string;
	articleTitle: string;
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

interface Turn {
	question: string;
	response: AskResponse | null;
	error: string | null;
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

// Match BOE and regional bulletin IDs: BOE-A-YYYY-NNNNN, BOA-d-NNNNN, BOJA-b-NNNNN, DOGV-i-NNNNN, etc.
const CITE_PATTERN =
	/\[([A-Z]{2,5}-[A-Za-z]-\d{4}-\d+),\s*(Art(?:ículo|\.)\s*\d+(?:\.\d+)?(?:\s*(?:bis|ter|quater|quinquies|sexies|septies))?[^[\]]*?)\]/g;

function buildCitationMap(citations: Citation[]): Map<string, Citation> {
	const map = new Map<string, Citation>();
	for (const c of citations) {
		map.set(c.normId, c);
	}
	return map;
}

function renderAnswerWithCitations(
	text: string,
	citations: Citation[],
): ReactNode[] {
	const citationMap = buildCitationMap(citations);
	const paragraphs = text.split("\n").filter((p) => p.trim());

	return paragraphs.map((paragraph, pIdx) => {
		const parts: ReactNode[] = [];
		let lastIndex = 0;

		for (const match of paragraph.matchAll(CITE_PATTERN)) {
			if (match.index > lastIndex) {
				parts.push(paragraph.slice(lastIndex, match.index));
			}

			const normId = match[1];
			const articleRef = match[2];
			const fullMatch = match[0];
			const citation = citationMap.get(normId);

			if (citation) {
				parts.push(
					<span key={`${normId}-${articleRef}`} className="ask-cite-wrapper">
						<a
							href={`/laws/${normId}`}
							target="_blank"
							rel="noopener noreferrer"
							className={`ask-cite-link${citation.verified === false ? " ask-cite-approx" : ""}`}
							aria-describedby={`cite-tip-${normId}-${articleRef}`}
							title={
								citation.verified === false
									? "Referencia aproximada"
									: undefined
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
						<span
							className="ask-cite-tooltip"
							role="tooltip"
							id={`cite-tip-${normId}-${articleRef}`}
						>
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
							<span className="ask-cite-tooltip-action">
								Ver en Ley Abierta
							</span>
						</span>
					</span>,
				);
			} else {
				parts.push(fullMatch);
			}

			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < paragraph.length) {
			parts.push(paragraph.slice(lastIndex));
		}

		if (parts.length === 0) {
			parts.push(paragraph);
		}

		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: paragraphs have no stable ID
			<p key={pIdx} className="ask-answer-paragraph">
				{parts}
			</p>
		);
	});
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

export default function AskChat() {
	const [turns, setTurns] = useState<Turn[]>(loadTurns);
	const [question, setQuestion] = useState("");
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);

	// Persist turns + scroll to bottom on change
	useEffect(() => {
		saveTurns(turns);
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [turns]);

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
			const res = await fetch(`${API_BASE}/v1/ask`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ question: text }),
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
			if (res.status === 503) {
				setTurns((prev) => {
					const updated = [...prev];
					updated[turnIndex] = {
						...updated[turnIndex],
						error:
							"El servicio de preguntas no está disponible en este momento.",
					};
					return updated;
				});
				return;
			}
			if (!res.ok) {
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

			const data: AskResponse = await res.json();
			setTurns((prev) => {
				const updated = [...prev];
				updated[turnIndex] = { ...updated[turnIndex], response: data };
				return updated;
			});
		} catch {
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

	return (
		<div className="ask-chat">
			{/* Disclaimer banner */}
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

			{/* Example questions (only when no history) */}
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

			{/* Conversation history */}
			{hasHistory && (
				<div className="ask-conversation">
					{turns.map((turn, turnIdx) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: turns have no stable ID
						<div key={turnIdx} className="ask-turn">
							{/* User question */}
							<div className="ask-turn-question">
								<span className="ask-turn-label">Tu pregunta</span>
								<p>{turn.question}</p>
							</div>

							{/* Response */}
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
												)}
											</div>

											{/* Inline citations list */}
											{turn.response.citations.length > 0 && (
												<div className="ask-turn-citations">
													<p className="ask-turn-citations-label">
														Fuentes citadas:
													</p>
													<ul className="ask-citations-list">
														{turn.response.citations.map((c) => (
															<li
																key={`${c.normId}-${c.articleTitle}`}
																className="ask-citation-card"
															>
																<a
																	href={`/laws/${c.normId}`}
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

											{/* Transparency */}
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
										</>
									)}
								</div>
							)}

							{/* Error */}
							{turn.error && (
								<div className="ask-turn-error">
									<p>{turn.error}</p>
								</div>
							)}
						</div>
					))}

					{/* Loading indicator for current question */}
					{loading && (
						<div className="ask-loading" role="status" aria-live="polite">
							<span className="ask-spinner-large" aria-hidden="true" />
							<p>Buscando en la legislación española...</p>
						</div>
					)}

					<div ref={bottomRef} />
				</div>
			)}

			{/* Input area (always visible at bottom) */}
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
