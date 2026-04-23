/**
 * Markdown linter for legislative documents.
 *
 * Validates that the generated Markdown is clean, well-formatted,
 * and free of parsing artifacts.
 */

export interface LintIssue {
	rule: string;
	severity: "error" | "warning";
	line: number;
	message: string;
}

const REQUIRED_FRONTMATTER_FIELDS = [
	"title",
	"id",
	"country",
	"rank",
	"status",
];

const EDITORIAL_PREFIXES = [
	"Téngase en cuenta",
	"Redactado conforme a la corrección",
	"Redacción anterior:",
	"Esta modificación",
	"Véase en cuanto",
	"Véase, en cuanto",
	"Su anterior numeración",
	"En el mismo sentido se pronuncia",
	"Se deja sin efecto",
	"Se declara",
	"Se modifica por",
	"Se añade por",
	"Se deroga por",
];

/**
 * Lint a Markdown document and return all issues found.
 */
export function lintMarkdown(markdown: string): LintIssue[] {
	const issues: LintIssue[] = [];
	const lines = markdown.split("\n");

	checkFrontmatter(lines, issues);
	checkBrokenEmphasis(lines, issues);
	checkHtmlTags(lines, issues);
	checkHtmlEntities(lines, issues);
	checkEmptyHeadings(lines, issues);
	checkEditorialNotes(lines, issues);
	checkExcessiveBlanks(lines, issues);
	checkTableIntegrity(lines, issues);

	return issues;
}

function checkFrontmatter(lines: string[], issues: LintIssue[]) {
	if (lines[0] !== "---") {
		issues.push({
			rule: "valid-frontmatter",
			severity: "error",
			line: 1,
			message: "Document must start with YAML frontmatter (---)",
		});
		return;
	}

	const closingIdx = lines.indexOf("---", 1);
	if (closingIdx === -1) {
		issues.push({
			rule: "valid-frontmatter",
			severity: "error",
			line: 1,
			message: "Frontmatter missing closing ---",
		});
		return;
	}

	const frontmatter = lines.slice(1, closingIdx).join("\n");
	for (const field of REQUIRED_FRONTMATTER_FIELDS) {
		if (!frontmatter.includes(`${field}:`)) {
			issues.push({
				rule: "valid-frontmatter",
				severity: "error",
				line: 1,
				message: `Frontmatter missing required field: ${field}`,
			});
		}
	}
}

function checkBrokenEmphasis(lines: string[], issues: LintIssue[]) {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Skip table rows and formula/math lines (high false positive rate)
		const trimmedLine = line.trim();
		if (
			trimmedLine.startsWith("|") ||
			/\s\*\s/.test(trimmedLine) ||
			/^\*[A-Z].*=/.test(trimmedLine)
		)
			continue;

		// Detect space before closing * (not **)
		if (/[^*\s]\s+\*(?!\*)/.test(line) && /\*[^*]/.test(line)) {
			const singleStarPairs = line.match(/\*[^*]+\*/g);
			if (singleStarPairs) {
				for (const pair of singleStarPairs) {
					if (/\s\*$/.test(pair)) {
						issues.push({
							rule: "no-broken-emphasis",
							severity: "error",
							line: i + 1,
							message: `Broken italic emphasis (space before closing *): "${pair.slice(0, 40)}..."`,
						});
					}
				}
			}
		}

		// Detect space before closing **
		const boldPairs = line.match(/\*\*[^*]+\*\*/g);
		if (boldPairs) {
			for (const pair of boldPairs) {
				if (/\s\*\*$/.test(pair)) {
					issues.push({
						rule: "no-broken-emphasis",
						severity: "error",
						line: i + 1,
						message: `Broken bold emphasis (space before closing **): "${pair.slice(0, 40)}..."`,
					});
				}
			}
		}
	}
}

/** Strip markdown image syntax ![...](...) using linear scan (no regex backtracking). */
function stripMarkdownImages(line: string): string {
	let result = "";
	let i = 0;
	while (i < line.length) {
		if (line[i] === "!" && line[i + 1] === "[") {
			// Find closing ]
			let j = i + 2;
			while (j < line.length && line[j] !== "]") j++;
			if (j < line.length && line[j + 1] === "(") {
				// Find closing )
				let k = j + 2;
				while (k < line.length && line[k] !== ")") k++;
				if (k < line.length) {
					i = k + 1; // Skip entire ![...](...)
					continue;
				}
			}
		}
		result += line[i];
		i++;
	}
	return result;
}

/** Known HTML tags to detect. Avoids false positives on literal < > in legal text. */
const HTML_TAG_NAMES =
	"a|b|br|blockquote|code|div|em|h[1-6]|i|img|ins|li|ol|p|pre|span|strong|sub|sup|table|tbody|td|tfoot|th|thead|tr|u|ul";

function checkHtmlTags(lines: string[], issues: LintIssue[]) {
	const tagRegex = new RegExp(`<\\/?(${HTML_TAG_NAMES})(?:\\s[^>]*)?>`, "i");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Skip frontmatter and Markdown image syntax
		if (line === "---") continue;
		const cleaned = stripMarkdownImages(line);
		const match = cleaned.match(tagRegex);
		if (match) {
			issues.push({
				rule: "no-html-tags",
				severity: "error",
				line: i + 1,
				message: `Residual HTML tag found: ${match[0]}`,
			});
		}
	}
}

function checkHtmlEntities(lines: string[], issues: LintIssue[]) {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const match = line.match(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i);
		if (match) {
			issues.push({
				rule: "no-html-entities",
				severity: "error",
				line: i + 1,
				message: `Unresolved HTML entity: ${match[0]}`,
			});
		}
	}
}

function checkEmptyHeadings(lines: string[], issues: LintIssue[]) {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (/^#{1,6}\s*$/.test(line)) {
			issues.push({
				rule: "no-empty-headings",
				severity: "error",
				line: i + 1,
				message: "Empty heading",
			});
		}
	}
}

function checkEditorialNotes(lines: string[], issues: LintIssue[]) {
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		for (const prefix of EDITORIAL_PREFIXES) {
			if (line.startsWith(prefix)) {
				issues.push({
					rule: "no-editorial-notes",
					severity: "error",
					line: i + 1,
					message: `Editorial note leaked into output: "${line.slice(0, 60)}..."`,
				});
				break;
			}
		}
	}
}

function checkExcessiveBlanks(lines: string[], issues: LintIssue[]) {
	let consecutive = 0;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.trim() === "") {
			consecutive++;
			if (consecutive >= 3) {
				issues.push({
					rule: "no-excessive-blanks",
					severity: "warning",
					line: i + 1,
					message: `${consecutive} consecutive blank lines`,
				});
			}
		} else {
			consecutive = 0;
		}
	}
}

function checkTableIntegrity(lines: string[], issues: LintIssue[]) {
	let inTable = false;
	let expectedCols = 0;
	let tableStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const isTableRow = line.startsWith("|") && line.endsWith("|");

		if (isTableRow) {
			const cols = line.split("|").length - 2; // subtract empty first/last from split
			if (!inTable) {
				inTable = true;
				expectedCols = cols;
				tableStartLine = i + 1;
			} else if (cols !== expectedCols) {
				issues.push({
					rule: "table-integrity",
					severity: "warning",
					line: i + 1,
					message: `Table column count mismatch: expected ${expectedCols}, got ${cols} (table started at line ${tableStartLine})`,
				});
			}
		} else {
			inTable = false;
		}
	}
}
