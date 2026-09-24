/**
 * Validate a downloaded build manifest before build-with-progress.sh uses it.
 *
 * 2026-09-24: `curl -sf` of the ~100 MB article-summaries manifest failed in
 * transport after 6 s (the API had served it with 200), the script only
 * warned, and the deploy published 12k law pages with no article summaries.
 * A missing, truncated or wrong-shaped manifest must fail the build instead.
 *
 * Usage: bun scripts/check-manifest.ts <file> <main|articles> <min-bytes>
 * Exit 0 and prints a one-line summary when valid; exit 1 with the reason.
 */

import { readFileSync, statSync } from "node:fs";

export type ManifestKind = "main" | "articles";

export function validateManifest(
	text: string,
	kind: ManifestKind,
	minBytes: number,
): { ok: true; summary: string } | { ok: false; reason: string } {
	const bytes = Buffer.byteLength(text);
	if (bytes < minBytes) {
		return {
			ok: false,
			reason: `${bytes} bytes, below the ${minBytes}-byte minimum (truncated or partial?)`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			ok: false,
			reason: `invalid JSON (${err instanceof Error ? err.message : "parse error"})`,
		};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "not a JSON object" };
	}
	const obj = raw as Record<string, unknown>;
	if (kind === "main") {
		const citizens = obj.citizens;
		if (
			!citizens ||
			typeof citizens !== "object" ||
			typeof obj.omnibus !== "object"
		) {
			return { ok: false, reason: "missing 'citizens' or 'omnibus'" };
		}
		const n = Object.keys(citizens).length;
		if (n === 0) return { ok: false, reason: "'citizens' is empty" };
		return { ok: true, summary: `${n} citizens, ${bytes} bytes` };
	}
	const n = Object.keys(obj).length;
	if (n === 0) return { ok: false, reason: "no norms" };
	return { ok: true, summary: `${n} norms, ${bytes} bytes` };
}

if (import.meta.main) {
	const [file, kind, min] = process.argv.slice(2);
	if (!file || (kind !== "main" && kind !== "articles") || !min) {
		console.error(
			"usage: check-manifest.ts <file> <main|articles> <min-bytes>",
		);
		process.exit(2);
	}
	let text: string;
	try {
		statSync(file);
		text = readFileSync(file, "utf-8");
	} catch {
		console.error(`missing file ${file}`);
		process.exit(1);
	}
	const r = validateManifest(text, kind, Number(min));
	if (r.ok) {
		console.log(r.summary);
	} else {
		console.error(r.reason);
		process.exit(1);
	}
}
