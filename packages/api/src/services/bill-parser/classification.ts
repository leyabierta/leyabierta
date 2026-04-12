/**
 * Bill Parser — modification classification and ordinal splitting.
 */

import { classifyWithLLM } from "./llm.ts";
import type { BillModification } from "./types.ts";
import { buildOrdinalPattern } from "./types.ts";
import { buildQuotedRanges } from "./utils.ts";

// ── Modification classification ──

function classifyModification(
	ordinal: string,
	text: string,
): BillModification | null {
	const firstLine = text.split("\n")[0] ?? "";
	// Some patterns span 2-3 lines (e.g., "Se introduce, dentro de\nla sección..., un nuevo X")
	// Use the text up to the first «» block or first 500 chars as the "header"
	const quoteStart = text.indexOf("«");
	const header = (
		quoteStart > 0 ? text.slice(0, quoteStart) : text.slice(0, 500)
	).replace(/\n/g, " ");

	// "Se suprime el Capítulo/Título X" → suppress_chapter
	const suppressChapterMatch = firstLine.match(
		/Se suprime[n]? (?:el |la )?(?:Capítulo|Título|Sección) .+/i,
	);
	if (suppressChapterMatch) {
		return {
			ordinal,
			changeType: "suppress_chapter",
			targetProvision: suppressChapterMatch[0]
				.replace(/^Se suprime[n]? (?:el |la )?/, "")
				.trim()
				.replace(/\.$/, ""),
			newText: "",
			sourceText: text,
		};
	}

	// "Se modifica el artículo X, que quedan? redactado como sigue:" / "...en los siguientes términos:"
	// Also handles parenthetical: "Se modifica, en su cuarto párrafo, el apartado 2 del artículo X"
	// Try firstLine first, then header for multiline cases
	const modifyMatch =
		firstLine.match(
			/Se modifica[n]?(?:,\s+[^,]+,)?\s+(?:el |la |los |las )?(.+?),?\s+(?:que )?(?:queda(?:n|ndo)?|pasa[n]? a (?:tener|ser|denominarse))[\s\S]*?(?:redactad|siguiente|tenor|como|sigue|establece|modo|contenido|términos|forma)/i,
		) ||
		header.match(
			/Se modifica[n]?(?:,\s+[^,]+,)?\s+(?:el |la |los |las )?(.+?),?\s+(?:que )?(?:queda(?:n|ndo)?|pasa[n]? a (?:tener|ser|denominarse))[\s\S]*?(?:redactad|siguiente|tenor|como|sigue|establece|modo|contenido|términos|forma)/i,
		);
	if (modifyMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: modifyMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se añade/introduce/adiciona un nuevo X" or "Se incorpora un nuevo X"
	// Allows optional parenthetical location: "Se introduce, dentro de ..., un nuevo X"
	// Uses header (multiline) because location clauses often span line breaks
	const addMatch = header.match(
		/Se (?:añade[n]?|introduce[n]?|incorpora[n]?|adiciona[n]?)(?:,\s+(?:dentro de|en) .+?,\s+| )(?:un(?:a|o)? (?:nuevo?|nueva)? )?(.+?)(?:,?\s+(?:con (?:la siguiente|el siguiente)|que queda|integrado)|$)/i,
	);
	if (addMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: addMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se añade/adiciona un segundo párrafo al apartado X" (longer add pattern)
	const addParrafoMatch = header.match(
		/Se (?:añade|introduce|adiciona)[n]? (.+?)(?:,?\s+(?:con (?:la siguiente redacción|el siguiente tenor)|que quedan? redactad))/i,
	);
	if (addParrafoMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: addParrafoMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se suprime X" (single article/paragraph — not chapter)
	const deleteMatch = firstLine.match(
		/Se suprime[n]? (?:el |la |los |las )?(.+)/i,
	);
	if (deleteMatch) {
		return {
			ordinal,
			changeType: "delete",
			targetProvision: deleteMatch[1]!.trim().replace(/\.$/, ""),
			newText: "",
			sourceText: text,
		};
	}

	// "Se modifica la numeración y contenido del artículo X, que pasa a ser..."
	const renumberMatch = firstLine.match(
		/Se modifica la (?:numeración|ubicación)(?: y (?:el )?contenido)? (?:de|del) (?:el |la )?(.+?), que pasa/i,
	);
	if (renumberMatch) {
		return {
			ordinal,
			changeType: "renumber",
			targetProvision: renumberMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "los actuales artículos X y Y se renumeran como artículos Z y W"
	// Uses header (multiline) because text often wraps across lines
	const passiveRenumberMatch = header.match(
		/(?:los actuales |el actual )(.+?)\s+se renumeran? como/i,
	);
	if (passiveRenumberMatch) {
		return {
			ordinal,
			changeType: "renumber",
			targetProvision: passiveRenumberMatch[1]!.trim(),
			newText: "",
			sourceText: text,
		};
	}

	// "El artículo X pasa a numerarse/ser Y, y se introduce un nuevo Z"
	// Compound renumber+add — classify as add (the introduction is the substantive change)
	// Uses header (multiline) because these patterns often wrap
	const compoundRenumberAddMatch = header.match(
		/^(?:El |La |Los |Las )(.+?)\s+(?:actual\s+)?pasa[n]?\s+a\s+(?:numerarse|ser)/i,
	);
	if (compoundRenumberAddMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: compoundRenumberAddMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// Fallback: any "Se modifica" pattern
	const genericModify = firstLine.match(/Se modifica[n]? (.+?)(?:\.|,|$)/i);
	if (genericModify) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: genericModify[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "El/La [target] quedan? redactado/a ..." — many variants:
	// "en los siguientes términos", "de la siguiente forma/manera", "del siguiente modo",
	// "con el siguiente tenor literal", "con la siguiente redacción", "como sigue"
	// Also: "En el artículo X quedan? redactado...", "X se redacta con el siguiente tenor"
	// Uses header (multiline) because target+verb often span lines
	const directRedactMatch = header.match(
		/^(?:En )?(?:el |la |los |las )(.+?)\s+(?:queda(?:n|rá[n]?)?\s+(?:redactad[oa]s?|modificad[oa]s?)|tendrá[n]?\s+la siguiente redacción|se redacta[n]?)\s+(?:en los siguientes términos|de la siguiente (?:forma|manera)|del siguiente modo|con (?:el siguiente tenor(?: literal)?|la siguiente redacción|el siguiente contenido)|como sigue|en sus apart)/i,
	);
	// Variant: "X queda con la siguiente redacción:" / "X queda como sigue:"
	const directQuedaMatch =
		!directRedactMatch &&
		header.match(
			/^(?:En )?(?:el |la |los |las )(.+?)\s+queda[n]?\s+(?:con la siguiente redacción|como sigue|con el siguiente tenor(?: literal)?)/i,
		);
	const redactMatch = directRedactMatch || directQuedaMatch;
	if (redactMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: redactMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Artículo cuarto." as direct target (LOMLOE pattern)
	// When the modification just names the target article without "Se modifica..."
	const directArticleMatch = firstLine.match(
		/^(?:Artículo|Apartado|Párrafo|Letra|Sección|Capítulo|Título|Disposición) .+/i,
	);
	if (directArticleMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: firstLine!.trim().replace(/[.:]+$/, ""),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Se dota de contenido al artículo X" (variant of add — article existed but was empty)
	const dotaMatch = header.match(
		/Se dota de contenido (?:al |a la |a los |a las )(.+?)(?:,|\.|$)/i,
	);
	if (dotaMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: dotaMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// "Todas las referencias que [ley] hace a X se entenderán hechas a Y" (textual substitution)
	const referenciasMatch = header.match(/Todas las referencias/i);
	if (referenciasMatch) {
		return {
			ordinal,
			changeType: "modify",
			targetProvision: header.slice(0, 80).trim(),
			newText: "",
			sourceText: text,
		};
	}

	// "Se crea un nuevo artículo X" / "Se crea, dentro de ..., un «Capítulo»" (variant of add)
	const createMatch =
		header.match(
			/Se crea[n]?(?:,\s+(?:dentro de|en) .+?,\s+| )(?:un(?:a|o)? (?:nuevo?|nueva?)? )?(.+?)(?:,?\s+(?:con (?:la siguiente|el siguiente)|que queda)|$)/i,
		) ||
		firstLine!.match(
			/Se crea[n]?(?:,\s+[^,]+,\s+| )(?:un(?:a|o)? )?(.+?)(?:\s+(?:con (?:la|el)|que queda|en el que)|$)/i,
		);
	if (createMatch) {
		return {
			ordinal,
			changeType: "add",
			targetProvision: createMatch[1]!.trim(),
			newText: extractQuotedText(text),
			sourceText: text,
		};
	}

	// Unrecognized — will be retried with LLM if apiKey is available
	return null;
}

export function extractQuotedText(text: string): string {
	const quoted = text.match(/«([\s\S]*?)»/);
	return quoted ? quoted[1]!.trim() : "";
}

// ── Ordinal splitting ──

function splitByOrdinals(
	text: string,
): Array<{ ordinal: string; text: string }> {
	const pattern = buildOrdinalPattern();
	const parts: Array<{ ordinal: string; text: string }> = [];

	// Replace «...» quoted blocks with placeholders to avoid matching ordinals
	// inside replacement text (e.g., "«Uno. Los seguros...»" is content, not an ordinal)
	const PLACEHOLDER = "\x00QUOTED\x00";
	const quotedRanges = buildQuotedRanges(text);
	let masked = text;
	// Replace from end to preserve indices
	for (let i = quotedRanges.length - 1; i >= 0; i--) {
		const [start, end] = quotedRanges[i]!;
		masked =
			masked.slice(0, start) +
			PLACEHOLDER.repeat(Math.ceil((end - start) / PLACEHOLDER.length)).slice(
				0,
				end - start,
			) +
			masked.slice(end);
	}

	const matches = [...masked.matchAll(pattern)];

	for (let i = 0; i < matches.length; i++) {
		const start = matches[i]!.index! + matches[i]![0].length;
		const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
		// Use original text (not masked) for the actual content
		parts.push({
			ordinal: matches[i]![1]!,
			text: text.slice(start, end).trim(),
		});
	}

	return parts;
}

/** Split by numeric ordinals (1. 2. 3.) — fallback when text ordinals yield 0 results */
function splitByNumericOrdinals(
	text: string,
): Array<{ ordinal: string; text: string }> {
	const parts: Array<{ ordinal: string; text: string }> = [];

	// Mask «...» blocks first
	const quotedRanges = buildQuotedRanges(text);
	let masked = text;
	for (let i = quotedRanges.length - 1; i >= 0; i--) {
		const [start, end] = quotedRanges[i]!;
		masked =
			masked.slice(0, start) + " ".repeat(end - start) + masked.slice(end);
	}

	// Match "N. " at start of line where N is a number
	const pattern = /(?:^|\n)(\d+)\.\s+/g;
	const matches = [...masked.matchAll(pattern)];

	// Validate: numeric ordinals should be sequential (1, 2, 3...) to avoid false positives
	if (matches.length < 2) return [];
	const nums = matches.map((m) => Number.parseInt(m[1]!, 10));
	if (nums[0] !== 1 || nums[1] !== 2) return []; // Must start with 1, 2

	for (let i = 0; i < matches.length; i++) {
		const start = matches[i]!.index! + matches[i]![0].length;
		const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
		parts.push({
			ordinal: matches[i]![1]!,
			text: text.slice(start, end).trim(),
		});
	}

	// Final validation: at least 50% of ordinals must look like MODIFICATION instructions
	// (not just any sentence — must contain modification verbs/patterns)
	const modLikeParts = parts.filter((p) => {
		const chunk = p.text.slice(0, 200);
		return /Se modifica|Se añade|Se introduce|Se adiciona|Se suprime|Se crea|Se deroga|queda(?:n)?\s+(?:redactad|modificad|con la siguiente)|pasa a (?:ser|tener|denominarse)/i.test(
			chunk,
		);
	});
	if (modLikeParts.length < parts.length * 0.5) return []; // Too many non-modification ordinals

	return parts;
}

export function parseModifications(
	text: string,
	_apiKey?: string,
): BillModification[] {
	// Try text ordinals first (Uno. Dos. Tres.)
	let parts = splitByOrdinals(text);

	// Fallback: numeric ordinals (1. 2. 3.) — used by some Serie B bills
	if (parts.length === 0) {
		parts = splitByNumericOrdinals(text);
	}

	const modifications: BillModification[] = [];
	const unclassifiedParts: Array<{ ordinal: string; text: string }> = [];

	for (const part of parts) {
		const mod = classifyModification(part.ordinal, part.text);
		if (mod) {
			modifications.push(mod);
		} else {
			unclassifiedParts.push(part);
		}
	}

	// Fallback: no ordinals at all, but body IS a modification statement
	// E.g., "Los apartados 2 y 4 del artículo 23 quedan redactados del siguiente modo:"
	if (modifications.length === 0 && parts.length === 0) {
		const directModMatch = text.match(
			/(?:Se modifica[n]?\s+(?:el |la |los |las )?|(?:Los? |Las? |El |La ))((?:artículo|apartado|párrafo|letra|número|disposición).+?)(?:,?\s+(?:que )?quedan?\s+(?:redactad|modificad)|,?\s+que pasa)/is,
		);
		if (directModMatch) {
			const mod = classifyModification(
				"direct",
				text.slice(text.indexOf(directModMatch[0])),
			);
			if (mod) {
				modifications.push(mod);
			} else {
				unclassifiedParts.push({
					ordinal: "direct",
					text: text.slice(text.indexOf(directModMatch[0])),
				});
			}
		}
	}

	// Store unclassified for LLM fallback (resolved in parseModificationsAsync)
	// biome-ignore lint/suspicious/noExplicitAny: internal transport between parseModifications and parseModificationsAsync
	(modifications as any).__unclassified = unclassifiedParts;

	return modifications;
}

/** Async wrapper that resolves unclassified ordinals with LLM */
export async function parseModificationsAsync(
	text: string,
	apiKey?: string,
): Promise<BillModification[]> {
	const modifications = parseModifications(text, apiKey);
	const unclassified: Array<{ ordinal: string; text: string }> =
		// biome-ignore lint/suspicious/noExplicitAny: internal __unclassified property from parseModifications
		(modifications as any).__unclassified ?? [];
	// biome-ignore lint/suspicious/noExplicitAny: internal __unclassified property from parseModifications
	delete (modifications as any).__unclassified;

	// LLM per-ordinal fallback: classify any ordinals regex couldn't handle
	if (unclassified.length > 0 && apiKey) {
		for (const part of unclassified) {
			const llmMods = await classifyWithLLM(apiKey, part.text);
			if (llmMods.length > 0) {
				for (const lm of llmMods) {
					lm.ordinal = part.ordinal;
				}
				modifications.push(...llmMods);
			} else {
				// Both regex AND LLM failed — this is a genuine unclassifiable ordinal
				console.warn(
					`  [warn] Could not classify ordinal "${part.ordinal}": ${part.text.split("\n")[0]!.slice(0, 80)}`,
				);
			}
		}
	} else if (unclassified.length > 0) {
		// No API key — warn about unclassified ordinals
		for (const part of unclassified) {
			console.warn(
				`  [warn] Could not classify ordinal "${part.ordinal}": ${part.text.split("\n")[0]!.slice(0, 80)}`,
			);
		}
	}

	return modifications;
}
