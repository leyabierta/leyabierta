import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// llms-full.txt is prose inside a template literal and needs astro:content to
// build, so guard the source against drift that already shipped once: values
// and endpoints the API does not have.
const source = await Bun.file(
	join(import.meta.dir, "../pages/llms-full.txt.ts"),
).text();

describe("llms-full.txt API reference", () => {
	test("uses the real status value (derogada), never derogado", () => {
		expect(source).not.toContain('"derogado"');
		expect(source).toContain('"derogada"');
	});

	test("does not document the nonexistent articles endpoint", () => {
		expect(source).not.toContain("/articles/");
	});
});
