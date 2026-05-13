import type { QAEntry } from "../qa-schema.ts";
import { extractCitations, readJsonl } from "./util.ts";

const BASE = "/Volumes/Disco1TB/datasets/leyabierta/huggingface/sinai-alia-cqa";

interface SinaiCqaRaw {
	id_chunk: string;
	id_document: string;
	passage: string;
	question: string;
	answer: string;
	character?: string;
	difficulty?: string;
}

type Variant = "boja" | "parlamint";

async function* adaptVariant(
	variant: Variant,
	path: string,
): AsyncGenerator<QAEntry> {
	for await (const row of readJsonl<SinaiCqaRaw>(path)) {
		if (!row.question || !row.answer || !row.id_chunk) continue;

		const source =
			variant === "boja" ? "sinai-cqa-boja" : "sinai-cqa-parlamint";
		const id = `${source}_${row.id_chunk}`;

		// Deduplicate citations from passage + answer
		const fromPassage = extractCitations(row.passage ?? "");
		const fromAnswer = extractCitations(row.answer ?? "");
		const citations_raw = [...new Set([...fromPassage, ...fromAnswer])];

		const entry: QAEntry = {
			id,
			source,
			question: row.question,
			answer: row.answer,
			context: row.passage || undefined,
			norms: {
				citations_raw,
				boe_a_ids: [],
			},
			metadata: {
				domain: variant === "boja" ? "admin" : "parliament",
				jurisdiction: "es-an",
				difficulty: row.difficulty,
				character: row.character,
				source_doc_id: row.id_document,
			},
		};

		yield entry;
	}
}

export async function* adapt(): AsyncGenerator<QAEntry> {
	yield* adaptVariant("boja", `${BASE}/boja.jsonl`);
	yield* adaptVariant("parlamint", `${BASE}/parlamint_es_an.jsonl`);
}
