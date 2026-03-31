/**
 * Convert JSON cache files to Markdown for Content Collections.
 * Usage: bun run scripts/json-to-markdown.ts [--limit N]
 */

import { readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const JSON_DIR = "./data/json";
const OUTPUT_DIR = "./content/laws";
const limit = Number(process.argv.find((_, i, a) => a[i - 1] === "--limit") ?? "0");

function escapeYaml(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function jurisdictionFromSource(source: string, id: string): string {
	// Extract from ELI URL: /eli/es-pv/... → es-pv
	const eliMatch = source.match(/\/eli\/([a-z]{2}(?:-[a-z]{2})?)\//);
	if (eliMatch) return eliMatch[1]!;

	// Fallback: bulletin prefix
	const prefixMap: Record<string, string> = {
		BOA: "es-ar", BOJA: "es-an", DOGC: "es-ct", DOGV: "es-vc",
		BOPV: "es-pv", DOG: "es-ga", BORM: "es-mc", BOC: "es-cn",
		BOCM: "es-md", BOCL: "es-cl", BOEN: "es-na", DOE: "es-ex",
		BOIB: "es-ib", BORI: "es-ri", BOPA: "es-as", BOCANT: "es-cb",
	};
	const prefix = id.split("-")[0]!;
	return prefixMap[prefix] ?? "es";
}

const files = readdirSync(JSON_DIR).filter(f => f.endsWith(".json"));
const toProcess = limit > 0 ? files.slice(0, limit) : files;
let count = 0;

for (const file of toProcess) {
	try {
		const raw = await Bun.file(join(JSON_DIR, file)).json();
		const m = raw.metadata;
		const jurisdiction = jurisdictionFromSource(m.source ?? "", m.id);

		const dir = join(OUTPUT_DIR, jurisdiction);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const lines = [
			"---",
			`titulo: "${escapeYaml(m.title)}"`,
			`identificador: "${m.id}"`,
			`pais: "${m.country ?? "es"}"`,
			`jurisdiccion: "${jurisdiction}"`,
			`rango: "${m.rank}"`,
			`fecha_publicacion: "${m.published}"`,
			`ultima_actualizacion: "${m.updated}"`,
			`estado: "${m.status}"`,
			`departamento: "${escapeYaml(m.department ?? "")}"`,
			`fuente: "${m.source ?? ""}"`,
			"---",
			"",
			`# ${m.title}`,
			"",
		];

		for (const art of raw.articles ?? []) {
			if (art.title) lines.push(`## ${art.title}`);
			if (art.currentText) lines.push(art.currentText);
			lines.push("");
		}

		await Bun.write(join(dir, `${m.id}.md`), lines.join("\n"));
		count++;
	} catch (e) {
		console.error(`Error processing ${file}:`, e);
	}
}

console.log(`Generated ${count} Markdown files in ${OUTPUT_DIR}/`);
