/**
 * Unified Q&A schema for the normalization layer.
 * Distinct from schema.ts (v3 eval pipeline) — this is for raw dataset normalization
 * across heterogeneous sources before they feed into the eval harness or fine-tuning.
 */

import { z } from "zod";

export const QASourceSchema = z.enum([
	"dgt-generales",
	"dgt-vinculantes",
	"sinai-cqa-boja",
	"sinai-cqa-parlamint",
	"refugiados",
	"divorce",
	"sinai-triplets",
]);

export type QASource = z.infer<typeof QASourceSchema>;

/**
 * Aligned citation entry produced by enrich-citations.ts.
 * One entry per citations_raw element, in the same order.
 * Use this (not boe_a_ids[]) for any per-citation lookup that requires
 * knowing which article maps to which BOE-A ID.
 */
export const QACitationSchema = z.object({
	raw: z.string(),
	boe_a_id: z.string().nullable(),
	article: z.string().nullable(),
});

export type QACitation = z.infer<typeof QACitationSchema>;

export const QANormsSchema = z.object({
	citations_raw: z.array(z.string()),
	/**
	 * Aligned: one entry per citations_raw element (same order).
	 * Present after enrich-citations.ts has run; absent in pre-enrichment data.
	 * MUST be used (not boe_a_ids[]) for article-level ground-truth evaluation.
	 */
	citations: z.array(QACitationSchema).optional(),
	/**
	 * Deduplicated resolved BOE-A IDs — backwards-compat derived field.
	 * Safe for norm-level retrieval evaluation (R@k) where the full set of
	 * expected norm IDs is the ground truth and order does not matter.
	 * DO NOT use to look up article numbers: the alignment is lost.
	 */
	boe_a_ids: z.array(z.string()),
});

export const QAMetadataSchema = z.object({
	domain: z
		.enum(["tax", "family", "asylum", "admin", "parliament", "constitutional"])
		.optional(),
	jurisdiction: z.string().optional(),
	difficulty: z.string().optional(),
	date: z.string().optional(),
	organo: z.string().optional(),
	character: z.string().optional(),
	source_doc_id: z.string().optional(),
});

export const QAEntrySchema = z.object({
	id: z.string().min(1),
	source: QASourceSchema,
	question: z.string().min(1),
	answer: z.string().min(1),
	context: z.string().optional(),
	norms: QANormsSchema,
	metadata: QAMetadataSchema,
});

export type QAEntry = z.infer<typeof QAEntrySchema>;

export const EvalEntrySchema = z.object({
	id: z.string().min(1),
	source: z.string().min(1),
	question: z.string().min(1),
	expected_norm_ids: z.array(z.string()),
	expected_articles: z.array(z.string()),
	domain: z.string().optional(),
	materia: z.string().optional(),
	difficulty: z.string().optional(),
});

export type EvalEntry = z.infer<typeof EvalEntrySchema>;
