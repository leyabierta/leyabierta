/**
 * Validate extractNewEntities() across all spike-bills PDFs.
 *
 * Usage: bun run packages/api/src/scripts/validate-entities.ts
 */

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
	extractTextFromPdf,
	parseBill,
} from "../services/bill-parser/parser.ts";

const SPIKE_DIR = join(import.meta.dirname, "../../../../data/spike-bills");

// Bills known to be pure modification (should have 0 entities)
const PURE_MODIFICATION_BILLS = new Set([
	"BOCG-14-A-62-1", // solo si es si — pure CP modification
	"BOCG-10-A-66-1", // reforma CP 2015 — pure CP modification
	"BOCG-14-B-295-1", // sedicion — pure CP modification
	"BOCG-15-B-23-1", // proposicion with article-based modifications
]);

interface BillResult {
	file: string;
	bocgId: string;
	entityCount: number;
	entities: Array<{
		name: string;
		entityType: string;
		article: string;
		description: string;
	}>;
	falsePositiveFlags: string[];
}

function flagFalsePositives(
	bocgId: string,
	entities: BillResult["entities"],
): string[] {
	const flags: string[] = [];

	// Flag if pure modification bill has entities
	if (PURE_MODIFICATION_BILLS.has(bocgId) && entities.length > 0) {
		flags.push(
			`PURE_MOD_WITH_ENTITIES: ${bocgId} is a pure modification bill but found ${entities.length} entities`,
		);
	}

	for (const e of entities) {
		// Generic terms (too short or vague)
		if (e.name.split(/\s+/).length < 3) {
			flags.push(`SHORT_NAME: "${e.name}" has fewer than 3 words`);
		}

		// Names that look like section headers
		if (/^(Titulo|Capitulo|Seccion|Libro|Parte)\b/i.test(e.name)) {
			flags.push(`SECTION_HEADER: "${e.name}" looks like a section header`);
		}

		// Names starting with articles/prepositions (generic reference)
		if (/^(el|la|los|las|del|de la|un|una)\s/i.test(e.name)) {
			flags.push(`GENERIC_REF: "${e.name}" starts with article/preposition`);
		}

		// Very long names (likely a sentence fragment, not an entity)
		if (e.name.length > 120) {
			flags.push(
				`TOO_LONG: "${e.name.slice(0, 80)}..." is suspiciously long (${e.name.length} chars)`,
			);
		}

		// Missing article reference
		if (!e.article) {
			flags.push(`NO_ARTICLE: "${e.name}" has no article reference`);
		}
	}

	return flags;
}

async function main() {
	const files = readdirSync(SPIKE_DIR)
		.filter((f) => f.toUpperCase().endsWith(".PDF"))
		.sort();

	console.log(`Found ${files.length} PDFs in ${SPIKE_DIR}\n`);
	console.log("=".repeat(100));

	const results: BillResult[] = [];

	for (const file of files) {
		const pdfPath = join(SPIKE_DIR, file);
		try {
			const text = extractTextFromPdf(pdfPath);
			const parsed = await parseBill(text);

			const entities = parsed.newEntities.map((e) => ({
				name: e.name,
				entityType: e.entityType,
				article: e.article,
				description: e.description,
			}));

			const flags = flagFalsePositives(parsed.bocgId, entities);

			const result: BillResult = {
				file,
				bocgId: parsed.bocgId,
				entityCount: entities.length,
				entities,
				falsePositiveFlags: flags,
			};
			results.push(result);

			// Print per-bill detail
			const entityNames = entities.map((e) => e.name).join(", ");
			const marker = flags.length > 0 ? " ⚠" : "";
			console.log(
				`${parsed.bocgId.padEnd(22)} | entities: ${String(entities.length).padStart(2)} | ${entityNames || "(none)"}${marker}`,
			);

			if (entities.length > 0) {
				for (const e of entities) {
					console.log(`  -> [${e.entityType}] ${e.article}: ${e.name}`);
					console.log(
						`     ${e.description.slice(0, 120)}${e.description.length > 120 ? "..." : ""}`,
					);
				}
			}
		} catch (err) {
			console.error(`ERROR processing ${file}: ${err}`);
			results.push({
				file,
				bocgId: basename(file, ".PDF"),
				entityCount: -1,
				entities: [],
				falsePositiveFlags: [`ERROR: ${err}`],
			});
		}
	}

	// Summary table
	console.log(`\n${"=".repeat(100)}`);
	console.log("\nSUMMARY TABLE\n");
	console.log(`${"BOCG ID".padEnd(22)} | ${"#".padStart(3)} | Entity names`);
	console.log("-".repeat(100));

	for (const r of results) {
		const names = r.entities.map((e) => e.name);
		const nameStr = names.length > 0 ? names.join("; ") : "(none)";
		console.log(
			`${r.bocgId.padEnd(22)} | ${String(r.entityCount).padStart(3)} | ${nameStr}`,
		);
	}

	// False positive report
	const flagged = results.filter((r) => r.falsePositiveFlags.length > 0);
	if (flagged.length > 0) {
		console.log(`\n${"=".repeat(100)}`);
		console.log("\nFALSE POSITIVE FLAGS\n");
		for (const r of flagged) {
			console.log(`${r.bocgId}:`);
			for (const flag of r.falsePositiveFlags) {
				console.log(`  - ${flag}`);
			}
			console.log();
		}
	}

	// Stats
	const totalEntities = results.reduce(
		(sum, r) => sum + Math.max(0, r.entityCount),
		0,
	);
	const billsWithEntities = results.filter((r) => r.entityCount > 0).length;
	const totalFlags = flagged.reduce(
		(sum, r) => sum + r.falsePositiveFlags.length,
		0,
	);

	console.log("=".repeat(100));
	console.log(`\nSTATS:`);
	console.log(`  Total PDFs processed:   ${results.length}`);
	console.log(`  Bills with entities:    ${billsWithEntities}`);
	console.log(`  Total entities found:   ${totalEntities}`);
	console.log(`  Bills with flags:       ${flagged.length}`);
	console.log(`  Total flags:            ${totalFlags}`);

	// Check pure modification bills specifically
	console.log(`\nPURE MODIFICATION BILL CHECK:`);
	for (const bocgId of PURE_MODIFICATION_BILLS) {
		const r = results.find((r) => r.bocgId === bocgId);
		if (r) {
			const status =
				r.entityCount === 0
					? "OK (0 entities)"
					: `FAIL (${r.entityCount} entities found)`;
			console.log(`  ${bocgId}: ${status}`);
			if (r.entityCount > 0) {
				for (const e of r.entities) {
					console.log(`    -> "${e.name}" [${e.entityType}] at ${e.article}`);
				}
			}
		} else {
			console.log(`  ${bocgId}: NOT FOUND in results`);
		}
	}
}

main().catch(console.error);
