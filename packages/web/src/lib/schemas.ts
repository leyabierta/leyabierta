/**
 * Zod schemas for API response validation.
 *
 * This module provides runtime type validation for API responses to ensure
 * data integrity and catch API contract violations early.
 */

import { z } from "zod";

/**
 * Schema for LawDetail API response.
 */
export const LawDetailSchema = z.object({
	id: z.string(),
	title: z.string(),
	short_title: z.string(),
	country: z.string(),
	rank: z.string(),
	published_at: z.string(),
	updated_at: z.string().nullable(),
	status: z.string(),
	department: z.string(),
	source_url: z.string(),
	citizen_summary: z.string(),
});

/**
 * Schema for OmnibusTopic API response.
 */
export const OmnibusTopicSchema = z.object({
	topic_label: z.string(),
	article_count: z.number(),
	headline: z.string(),
	summary: z.string(),
	is_sneaked: z.number(),
	block_ids: z.array(z.string()),
});

/**
 * Type inference from schemas.
 */
export type LawDetail = z.infer<typeof LawDetailSchema>;
export type OmnibusTopic = z.infer<typeof OmnibusTopicSchema>;
