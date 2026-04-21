/**
 * Unit tests for articleTypePenalty — deterministic article type classification.
 *
 * Disposiciones transitorias (dt*) are time-limited, so they get a heavy penalty.
 * Regular artículos (a*) get no penalty. This is a key part of the "LLM is a
 * narrator, not an adjudicator" architecture — conflicts are resolved
 * deterministically before the LLM sees the evidence.
 */

import { describe, expect, test } from "bun:test";
import { articleTypePenalty } from "../services/rag/pipeline.ts";

describe("articleTypePenalty", () => {
	test("regular articles get no penalty", () => {
		expect(articleTypePenalty("a48")).toBe(1.0);
		expect(articleTypePenalty("a48__4")).toBe(1.0);
		expect(articleTypePenalty("a1")).toBe(1.0);
		expect(articleTypePenalty("a102bis")).toBe(1.0);
	});

	test("disposiciones transitorias get 0.3x penalty", () => {
		expect(articleTypePenalty("dt13")).toBe(0.3);
		expect(articleTypePenalty("dtprimera")).toBe(0.3);
		expect(articleTypePenalty("dtsegunda")).toBe(0.3);
		expect(articleTypePenalty("dtseptima")).toBe(0.3);
		expect(articleTypePenalty("dtdecimotercera")).toBe(0.3);
	});

	test("disposiciones derogatorias get 0.1x penalty", () => {
		expect(articleTypePenalty("ddunica")).toBe(0.1);
		expect(articleTypePenalty("ddprimera")).toBe(0.1);
		expect(articleTypePenalty("dderunica")).toBe(0.1);
	});

	test("disposiciones finales get 0.5x penalty", () => {
		expect(articleTypePenalty("df1")).toBe(0.5);
		expect(articleTypePenalty("dfprimera")).toBe(0.5);
		expect(articleTypePenalty("dftrigesimoctava")).toBe(0.5);
	});

	test("disposiciones adicionales get 0.7x penalty", () => {
		expect(articleTypePenalty("da1")).toBe(0.7);
		expect(articleTypePenalty("datercera")).toBe(0.7);
		expect(articleTypePenalty("daquinta")).toBe(0.7);
	});

	test("unknown block_ids get no penalty (safe default)", () => {
		expect(articleTypePenalty("preambulo")).toBe(1.0);
		expect(articleTypePenalty("exposicion")).toBe(1.0);
		expect(articleTypePenalty("ley589")).toBe(1.0);
	});
});
