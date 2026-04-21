/**
 * Quick test for Q2 (paternidad) hallucination fix.
 * Runs Q2 5 times to check consistency since LLMs are non-deterministic.
 *
 * Usage:
 *   bun run packages/api/research/test-q2-hallucination.ts
 */

const apiBaseUrl = process.argv[2] ?? "http://localhost:3000";
const apiBypassKey = process.env.API_BYPASS_KEY ?? "";
const RUNS = 5;

const QUESTIONS = [
	"¿Cuánto dura la baja por paternidad?",
	"¿Cuántos días de vacaciones me corresponden al año?",
];

async function ask(question: string): Promise<string> {
	const res = await fetch(`${apiBaseUrl}/v1/ask`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiBypassKey ? { "x-api-key": apiBypassKey } : {}),
		},
		body: JSON.stringify({ question }),
	});
	if (!res.ok) throw new Error(`${res.status}`);
	const data = (await res.json()) as { answer: string };
	return data.answer;
}

for (const q of QUESTIONS) {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`Q: ${q}`);
	console.log("=".repeat(60));

	for (let i = 0; i < RUNS; i++) {
		const answer = await ask(q);
		// Extract the first number of weeks/days mentioned
		const weeksMatch = answer.match(/(\d+)\s*semanas/i);
		const daysMatch = answer.match(/(\d+)\s*días\s*(naturales|hábiles)?/i);
		const firstNumber = weeksMatch
			? `${weeksMatch[1]} semanas`
			: daysMatch
				? `${daysMatch[1]} días ${daysMatch[2] ?? ""}`
				: "no number found";

		console.log(
			`  Run ${i + 1}: ${firstNumber} — "${answer.slice(0, 120)}..."`,
		);
		await new Promise((r) => setTimeout(r, 500));
	}
}
