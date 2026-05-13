import type { QAEntry } from "../qa-schema.ts";
import { extractCitations, readJsonl, sha1 } from "./util.ts";

const PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/huggingface/legal-divorce-es/train.jsonl";

interface DivorceRaw {
	case_id: string;
	learnings: string;
	text: string;
	fecha?: string;
}

function extractSection(learnings: string, header: string): string {
	const m = learnings.match(
		new RegExp(`##\\s*${header}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, "i"),
	);
	return m?.[1]?.trim() ?? "";
}

// Extract Q&A from the structured `learnings` markdown.
// Question = case summary ("De qué va el caso").
// Answer = doctrine + learnings combined (Fallo is too short at ~62 chars median).
// Returns null if required sections are missing or too short.
function extractQA(
	learnings: string,
): { question: string; answer: string } | null {
	const caseDesc = extractSection(learnings, "De qué va el caso");
	const doctrina = extractSection(learnings, "Doctrina que se fija");
	const aprendizajes = extractSection(learnings, "Aprendizajes útiles");
	const fallo = extractSection(learnings, "Fallo");

	if (caseDesc.length < 20) return null;

	// Build answer from non-empty sections in order of richness
	const answerParts = [doctrina, aprendizajes, fallo].filter(
		(s) => s.length > 20,
	);
	if (answerParts.length === 0) return null;

	const answer = answerParts.join("\n\n");
	if (answer.length < 100) return null;

	const questionText = `¿Cuál es la doctrina constitucional aplicable en este caso? ${caseDesc}`;

	return { question: questionText, answer };
}

export async function* adapt(path = PATH): AsyncGenerator<QAEntry> {
	for await (const row of readJsonl<DivorceRaw>(path)) {
		if (!row.learnings || !row.text) continue;

		const qa = extractQA(row.learnings);
		if (!qa) {
			console.warn(`divorce: skipping ${row.case_id} — could not extract Q&A`);
			continue;
		}

		const id = `divorce_${sha1(row.text).slice(0, 12)}`;

		const entry: QAEntry = {
			id,
			source: "divorce",
			question: qa.question,
			answer: qa.answer,
			context: row.text || undefined,
			norms: {
				citations_raw: extractCitations(row.learnings),
				boe_a_ids: [],
			},
			metadata: {
				domain: "constitutional",
				jurisdiction: "es",
				date: row.fecha,
			},
		};

		yield entry;
	}
}
