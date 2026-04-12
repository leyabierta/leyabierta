/**
 * Bill Parser — PDF text extraction.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function extractTextFromPdf(pdfPath: string): string {
	if (!existsSync(pdfPath)) {
		throw new Error(`PDF not found: ${pdfPath}`);
	}

	// Write to temp file instead of stdout to work around bun worker thread bug
	// where execSync stdout capture is broken in bun test workspace mode.
	const tmpFile = join(tmpdir(), `pdftotext-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
	try {
		execSync(`pdftotext -raw "${pdfPath}" "${tmpFile}"`, {
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		});
		var text = readFileSync(tmpFile, "utf-8");
	} finally {
		try { unlinkSync(tmpFile); } catch { /* ignore */ }
	}

	return text
		.replace(/cve: BOCG-\d+-[A-Z]-\d+-\d+/g, "")
		.replace(
			/BOLETÍN OFICIAL DE LAS CORTES GENERALES\nCONGRESO DE LOS DIPUTADOS\n/g,
			"",
		)
		.replace(
			/Serie [AB] Núm\. \d+-\d+\s+\d+ de \w+ de \d+\s+Pág\. \d+/g,
			"",
		)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
