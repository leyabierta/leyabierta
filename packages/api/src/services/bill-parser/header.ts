/**
 * Bill Parser — header extraction (BOCG ID, date, title, transitional provisions).
 */

// ── Roman numeral conversion ──

const ROMAN_VALUES: Record<string, number> = {
	I: 1,
	V: 5,
	X: 10,
	L: 50,
	C: 100,
	D: 500,
	M: 1000,
};

export function romanToArabic(roman: string): string | null {
	if (!roman || !/^[IVXLCDM]+$/i.test(roman)) return null;
	const upper = roman.toUpperCase();
	let result = 0;
	for (let i = 0; i < upper.length; i++) {
		const current = ROMAN_VALUES[upper[i]!]!;
		const next = i + 1 < upper.length ? ROMAN_VALUES[upper[i + 1]!]! : 0;
		result += current < next ? -current : current;
	}
	return String(result);
}

// ── Header extraction ──

const SPANISH_MONTHS: Record<string, string> = {
	enero: "01",
	febrero: "02",
	marzo: "03",
	abril: "04",
	mayo: "05",
	junio: "06",
	julio: "07",
	agosto: "08",
	septiembre: "09",
	octubre: "10",
	noviembre: "11",
	diciembre: "12",
};

export function extractBocgId(text: string): string {
	// Look for BOCG ID in CVE references or header
	const cveMatch = text.match(/BOCG-(\d+-[A-Z]-\d+-\d+)/);
	if (cveMatch) return `BOCG-${cveMatch[1]}`;

	// Fallback: extract from "Serie A/B Núm. XX-Y"
	const serieMatch = text.match(
		/(\w+) LEGISLATURA\nSerie ([AB]):\n[\s\S]*?Núm\. (\d+-\d+)/,
	);
	if (serieMatch) {
		const legislatura = romanToArabic(serieMatch[1] ?? "") ?? serieMatch[1];
		return `BOCG-${legislatura}-${serieMatch[2]}-${serieMatch[3]}`;
	}

	return "unknown";
}

export function extractPublicationDate(text: string): string {
	// Match "DD de MONTH de YYYY" in the header area (first ~500 chars)
	const header = text.slice(0, 500);
	const dateMatch = header.match(/(\d{1,2}) de (\w+) de (\d{4})/);
	if (dateMatch) {
		const day = dateMatch[1]!.padStart(2, "0");
		const month = SPANISH_MONTHS[dateMatch[2]!.toLowerCase()];
		const year = dateMatch[3]!;
		if (month) return `${year}-${month}-${day}`;
	}
	return "unknown";
}

export function extractTitle(text: string): string {
	// Look for "PROYECTO DE LEY", "PROPOSICIÓN DE LEY", or "PROPOSICIÓN DE REFORMA" followed by the title
	const titleMatch = text.match(
		/(?:PROYECTO|PROPOSICIÓN) DE (?:LEY|REFORMA).*?\n\d+\/\d+\s+(.+?)(?:\n(?:La Mesa|Presentad))/s,
	);
	if (titleMatch) return titleMatch[1]!.replace(/\n/g, " ").trim();

	// Fallback: look for the title pattern after the reference number
	const fallback = text.match(
		/\d+\/\d+\s+(?:Proyecto|Proposición) de (?:Ley|Reforma) (.+?)(?:\.\n|\nLa Mesa)/s,
	);
	if (fallback) return fallback[1]!.replace(/\n/g, " ").trim();

	return "unknown";
}

// ── Transitional provisions extraction ──

export function extractTransitionalProvisions(text: string): string[] {
	const provisions: string[] = [];

	// Find all "Disposición transitoria X. Title.\nBody..."
	const dtRegex =
		/Disposición transitoria [\p{L}\d]+\.\s+(.+?)(?=\nDisposición (?:transitoria|derogatoria|final|adicional) [\p{L}\d]+\.|$)/gsu;

	for (const match of text.matchAll(dtRegex)) {
		provisions.push(match[1]!.trim());
	}

	return provisions;
}
