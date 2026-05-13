import type { QAEntry } from "../qa-schema.ts";
import {
	extractCitations,
	jurisdictionFromSourceId,
	readJsonl,
} from "./util.ts";

const PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/huggingface/sinai-alia-triplets/train.jsonl";

interface SinaiTripletsRaw {
	id_chunk: string;
	id_document: string;
	passage: string;
	query: string;
	answer: string;
	character?: string;
	difficulty?: string;
	source_id?: string;
}

export async function* adapt(path = PATH): AsyncGenerator<QAEntry> {
	for await (const row of readJsonl<SinaiTripletsRaw>(path)) {
		if (!row.query || !row.answer || !row.id_chunk) continue;

		const id = `sinai-triplets_${row.id_chunk}`;

		const fromPassage = extractCitations(row.passage ?? "");
		const fromAnswer = extractCitations(row.answer ?? "");
		const citations_raw = [...new Set([...fromPassage, ...fromAnswer])];

		const entry: QAEntry = {
			id,
			source: "sinai-triplets",
			question: row.query,
			answer: row.answer,
			context: row.passage || undefined,
			norms: {
				citations_raw,
				boe_a_ids: [],
			},
			metadata: {
				domain: "admin",
				jurisdiction: jurisdictionFromSourceId(row.source_id ?? ""),
				difficulty: row.difficulty,
				character: row.character,
				source_doc_id: row.id_document,
			},
		};

		yield entry;
	}
}
