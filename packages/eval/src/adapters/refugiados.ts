import type { QAEntry } from "../qa-schema.ts";
import { extractCitations, readJsonl, sha1 } from "./util.ts";

const PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/huggingface/instruct-legal-refugiados/full.jsonl";

interface RefugiadosRaw {
	question: string;
	context: string;
	answer: string;
	lang?: string;
	pais_origen?: string;
}

export async function* adapt(path = PATH): AsyncGenerator<QAEntry> {
	for await (const row of readJsonl<RefugiadosRaw>(path)) {
		if (!row.question || !row.answer) continue;

		const id = `refugiados_${sha1(row.question).slice(0, 12)}`;

		const fromContext = extractCitations(row.context ?? "");
		const fromAnswer = extractCitations(row.answer ?? "");
		const citations_raw = [...new Set([...fromContext, ...fromAnswer])];

		const entry: QAEntry = {
			id,
			source: "refugiados",
			question: row.question,
			answer: row.answer,
			context: row.context || undefined,
			norms: {
				citations_raw,
				boe_a_ids: [],
			},
			metadata: {
				domain: "asylum",
				jurisdiction: "es",
			},
		};

		yield entry;
	}
}
