/**
 * Panel decision logic tests for the 5-judge panel.
 *
 * Two selectable rules:
 * - `strict-5-of-5`: unanimous accept → accept; unanimous reject →
 *   reject; anything else → borderline.
 * - `balanced-4-of-5`: extension of Fix A — accepts >= 4 produces
 *   accept unless a major critical concern (leak / answer-fit /
 *   ambiguity) was raised by a rejecting judge, in which case the
 *   panel escalates to borderline.
 */

import { describe, expect, test } from "bun:test";
import type { JudgeConcern, JudgeVote } from "../schema.ts";
import { decidePanel } from "./judges.ts";

function vote(
	model: string,
	verdict: "accept" | "reject",
	concerns: JudgeConcern[] = [],
): JudgeVote {
	return {
		model,
		prompt: `${model}-prompt`,
		verdict,
		reason: "stub reason for test",
		concerns,
		tookMs: 0,
	};
}

function five(
	pattern: ("accept" | "reject")[],
	concerns: Record<number, JudgeConcern[]> = {},
): JudgeVote[] {
	if (pattern.length !== 5) {
		throw new Error("five() requires exactly 5 verdicts");
	}
	return pattern.map((v, i) => vote(`judge${i}`, v, concerns[i] ?? []));
}

describe("decidePanel — strict-5-of-5", () => {
	test("5/5 accept → accept", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "accept"]),
			"strict-5-of-5",
		);
		expect(d.verdict).toBe("accept");
		expect(d.accepts).toBe(5);
		expect(d.rejects).toBe(0);
	});

	test("4/5 accept → borderline", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "reject"]),
			"strict-5-of-5",
		);
		expect(d.verdict).toBe("borderline");
		expect(d.accepts).toBe(4);
	});

	test("3/5 accept → borderline", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "reject", "reject"]),
			"strict-5-of-5",
		);
		expect(d.verdict).toBe("borderline");
	});

	test("0/5 accept → reject", () => {
		const d = decidePanel(
			five(["reject", "reject", "reject", "reject", "reject"]),
			"strict-5-of-5",
		);
		expect(d.verdict).toBe("reject");
		expect(d.rejects).toBe(5);
	});

	test("strict mode ignores critical concerns when 5/5 accept", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "accept"], {
				0: [{ type: "leak", severity: "major", text: "noted" }],
			}),
			"strict-5-of-5",
		);
		expect(d.verdict).toBe("accept");
		expect(d.criticalConcernsRaised).toEqual(["leak"]);
	});
});

describe("decidePanel — balanced-4-of-5", () => {
	test("5/5 accept → accept", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "accept"]),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("accept");
		expect(d.accepts).toBe(5);
	});

	test("4/5 accept with no critical concerns → accept", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "reject"], {
				4: [
					{
						type: "specificity",
						severity: "minor",
						text: "could be more specific",
					},
				],
			}),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("accept");
		expect(d.accepts).toBe(4);
		expect(d.criticalConcernsRaised).toEqual([]);
	});

	test("4/5 accept with major leak from rejecting judge → borderline (Fix A)", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "reject"], {
				4: [
					{
						type: "leak",
						severity: "major",
						text: "filtra término clave",
					},
				],
			}),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("borderline");
		expect(d.criticalConcernsRaised).toEqual(["leak"]);
	});

	test("4/5 accept with major answer-fit from rejecting judge → borderline", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "reject"], {
				4: [
					{
						type: "answer-fit",
						severity: "major",
						text: "el artículo solo da contexto",
					},
				],
			}),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("borderline");
		expect(d.criticalConcernsRaised).toEqual(["answer-fit"]);
	});

	test("5/5 accept with major leak concern → still accept (no rejecting judge)", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "accept"], {
				0: [{ type: "leak", severity: "major", text: "borderline term" }],
			}),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("accept");
	});

	test("3/5 accept → borderline (not enough confidence)", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "reject", "reject"]),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("borderline");
		expect(d.accepts).toBe(3);
	});

	test("2/5 accept → borderline", () => {
		const d = decidePanel(
			five(["accept", "accept", "reject", "reject", "reject"]),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("borderline");
	});

	test("1/5 accept → borderline", () => {
		const d = decidePanel(
			five(["accept", "reject", "reject", "reject", "reject"]),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("borderline");
	});

	test("0/5 accept → reject", () => {
		const d = decidePanel(
			five(["reject", "reject", "reject", "reject", "reject"], {
				0: [{ type: "answer-fit", severity: "major", text: "wrong" }],
			}),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("reject");
		expect(d.rejects).toBe(5);
	});

	test("voice major concern is NOT critical (Fix A only on leak/answer-fit/ambiguity)", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "reject"], {
				4: [{ type: "voice", severity: "major", text: "too formal" }],
			}),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("accept");
		expect(d.criticalConcernsRaised).toEqual([]);
	});

	test("minor critical concern does NOT trigger Fix A escalation", () => {
		const d = decidePanel(
			five(["accept", "accept", "accept", "accept", "reject"], {
				4: [{ type: "leak", severity: "minor", text: "soft hint" }],
			}),
			"balanced-4-of-5",
		);
		expect(d.verdict).toBe("accept");
		expect(d.criticalConcernsRaised).toEqual([]);
	});
});
