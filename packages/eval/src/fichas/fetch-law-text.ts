/**
 * Fetch a norm's text from the BOE and render it with the current parser.
 *
 * Eval inputs must not come from the stored Markdown: norms ingested before
 * the blockquote fix (#217) lost the wording they insert into other laws,
 * which is the core of any modifying law.
 *
 *   bun run packages/eval/src/fichas/fetch-law-text.ts <id> <out.md>
 */

import { BoeClient } from "../../../pipeline/src/spain/boe-client.ts";
import { renderParagraphs } from "../../../pipeline/src/transform/markdown.ts";
import {
	getBlockAtDate,
	parseTextXml,
} from "../../../pipeline/src/transform/xml-parser.ts";

const [id, out] = process.argv.slice(2);
if (!id || !out) {
	console.error("usage: fetch-law-text.ts <norm-id> <out.md>");
	process.exit(1);
}

const xml = await new BoeClient().getText(id);
const blocks = parseTextXml(xml);
const today = new Date().toISOString().slice(0, 10);
const parts: string[] = [];
for (const block of blocks) {
	const version = getBlockAtDate(block, today);
	if (!version) continue;
	const md = renderParagraphs(version.paragraphs).trim();
	if (md) parts.push(md);
}
await Bun.write(out, `${parts.join("\n\n")}\n`);
console.log(`${id}: ${blocks.length} blocks, ${parts.join("").length} chars`);
