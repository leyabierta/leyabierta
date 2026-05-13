import type { QAEntry } from "../qa-schema.ts";
import { extractCitations, parseDgtDate, readJsonl } from "./util.ts";

const DGT_PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/dgt-consultas/raw/dgt-consultas-full.jsonl";

interface DgtRaw {
	docId: string;
	numConsulta: string;
	organo: string;
	fechaSalida: string;
	normativa: string;
	cuestion: string;
	descripcion: string;
	contestacion: string;
	category: "generales" | "vinculantes";
}

export async function* adapt(path = DGT_PATH): AsyncGenerator<QAEntry> {
	for await (const row of readJsonl<DgtRaw>(path)) {
		if (!row.cuestion || !row.contestacion) continue;

		const source =
			row.category === "vinculantes" ? "dgt-vinculantes" : "dgt-generales";
		const id = `${source}_${row.numConsulta || row.docId}`;

		const entry: QAEntry = {
			id,
			source,
			question: row.cuestion,
			answer: row.contestacion,
			context: row.descripcion || undefined,
			norms: {
				citations_raw: extractCitations(row.normativa ?? ""),
				boe_a_ids: [],
			},
			metadata: {
				domain: "tax",
				jurisdiction: "es",
				date: parseDgtDate(row.fechaSalida),
				organo: row.organo || undefined,
			},
		};

		yield entry;
	}
}
