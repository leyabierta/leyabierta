import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { QAEntrySchema } from "../src/qa-schema.ts";

const DGT_PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/dgt-consultas/raw/dgt-consultas-full.jsonl";
const SINAI_CQA_BOJA_PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/huggingface/sinai-alia-cqa/boja.jsonl";
const REFUGIADOS_PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/huggingface/instruct-legal-refugiados/full.jsonl";
const DIVORCE_PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/huggingface/legal-divorce-es/train.jsonl";
const TRIPLETS_PATH =
	"/Volumes/Disco1TB/datasets/leyabierta/huggingface/sinai-alia-triplets/train.jsonl";

async function firstEntry(
	gen: AsyncGenerator<unknown>,
): Promise<unknown | null> {
	const { value, done } = await gen.next();
	return done ? null : value;
}

describe("dgt adapter", () => {
	test.skipIf(!existsSync(DGT_PATH))(
		"produces valid QAEntry from first row",
		async () => {
			const { adapt } = await import("../src/adapters/dgt.ts");
			const entry = await firstEntry(adapt(DGT_PATH));
			expect(entry).not.toBeNull();
			const result = QAEntrySchema.safeParse(entry);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.source).toMatch(/^dgt-/);
				expect(result.data.metadata.domain).toBe("tax");
				expect(result.data.metadata.jurisdiction).toBe("es");
			}
		},
	);
});

describe("sinai-cqa adapter", () => {
	test.skipIf(!existsSync(SINAI_CQA_BOJA_PATH))(
		"produces valid QAEntry from BOJA file",
		async () => {
			const { adapt } = await import("../src/adapters/sinai-cqa.ts");
			const entry = await firstEntry(adapt());
			expect(entry).not.toBeNull();
			const result = QAEntrySchema.safeParse(entry);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.source).toBe("sinai-cqa-boja");
				expect(result.data.metadata.jurisdiction).toBe("es-an");
				expect(result.data.metadata.domain).toBe("admin");
			}
		},
	);
});

describe("refugiados adapter", () => {
	test.skipIf(!existsSync(REFUGIADOS_PATH))(
		"produces valid QAEntry from first row",
		async () => {
			const { adapt } = await import("../src/adapters/refugiados.ts");
			const entry = await firstEntry(adapt(REFUGIADOS_PATH));
			expect(entry).not.toBeNull();
			const result = QAEntrySchema.safeParse(entry);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.source).toBe("refugiados");
				expect(result.data.metadata.domain).toBe("asylum");
				expect(result.data.metadata.jurisdiction).toBe("es");
			}
		},
	);
});

describe("divorce adapter", () => {
	test.skipIf(!existsSync(DIVORCE_PATH))(
		"produces valid QAEntry from first extractable row",
		async () => {
			const { adapt } = await import("../src/adapters/divorce.ts");
			// Try up to 10 rows since some might be skipped
			let entry: unknown = null;
			let count = 0;
			for await (const e of adapt(DIVORCE_PATH)) {
				entry = e;
				count++;
				if (count >= 1) break;
			}
			expect(entry).not.toBeNull();
			const result = QAEntrySchema.safeParse(entry);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.source).toBe("divorce");
				expect(result.data.metadata.domain).toBe("constitutional");
			}
		},
	);
});

describe("sinai-triplets adapter", () => {
	test.skipIf(!existsSync(TRIPLETS_PATH))(
		"produces valid QAEntry from first row",
		async () => {
			const { adapt } = await import("../src/adapters/sinai-triplets.ts");
			const entry = await firstEntry(adapt(TRIPLETS_PATH));
			expect(entry).not.toBeNull();
			const result = QAEntrySchema.safeParse(entry);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.source).toBe("sinai-triplets");
				expect(result.data.metadata.domain).toBe("admin");
			}
		},
	);
});
