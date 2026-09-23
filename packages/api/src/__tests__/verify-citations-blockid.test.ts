import { describe, expect, it } from "bun:test";
import { verifyCitations } from "../services/rag/synthesis.ts";

// The web links each /pregunta citation to its article on the BOE
// (`act.php?id=<normId>#<blockId>`), so verified citations carry the block id.
describe("verifyCitations blockId", () => {
	const articles = [
		{
			normId: "BOE-A-2015-11430",
			blockId: "a38",
			blockTitle: "Artículo 38",
			normTitle: "Estatuto de los Trabajadores",
		},
		{
			normId: "BOE-A-1889-4763",
			// Sub-chunk of an article: link to the parent article.
			blockId: "art1019__2",
			blockTitle: "Artículo 1019",
			normTitle: "Código Civil",
		},
	];

	it("sets the block id on verified citations (parent block for sub-chunks)", () => {
		const out = verifyCitations(
			[
				{ normId: "BOE-A-2015-11430", articleTitle: "Artículo 38" },
				{ normId: "BOE-A-1889-4763", articleTitle: "Artículo 1019" },
			],
			articles,
		);
		expect(out.map((c) => [c.verified, c.blockId])).toEqual([
			[true, "a38"],
			[true, "art1019"],
		]);
	});

	it("leaves it out of approximate citations", () => {
		const [c] = verifyCitations(
			[{ normId: "BOE-A-2015-11430", articleTitle: "Artículo 99" }],
			articles,
		);
		expect(c!.verified).toBe(false);
		expect(c!.blockId).toBeUndefined();
	});
});
