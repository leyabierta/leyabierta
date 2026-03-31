/**
 * Programmatic weekly digest generator.
 *
 * Generates YAML (source of truth), web HTML, and email HTML for each profile.
 * NO AI involved — only DB queries and template rendering.
 * The citizen-writer AI step is separate (via /weekly-digest skill).
 *
 * Usage:
 *   bun run packages/api/src/scripts/generate-digest.ts --week 2026-W13
 *   bun run packages/api/src/scripts/generate-digest.ts --week 2026-W13 --profile sanitario
 *   bun run packages/api/src/scripts/generate-digest.ts --week 2026-W13 --html-only
 *
 * Flags:
 *   --week YYYY-WNN    Required. ISO week to generate.
 *   --profile ID       Only generate for this profile (default: all 8).
 *   --html-only        Skip YAML generation, just regenerate HTML from existing YAMLs.
 *   --site-url URL     Base URL for links (default: http://localhost:4321).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROFILES, type ThematicProfile } from "../data/profiles.ts";

// ── CLI args ──

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const week = getArg("week");
if (!week || !/^\d{4}-W\d{2}$/.test(week)) {
	console.error("Usage: --week YYYY-WNN (e.g. --week 2026-W13)");
	process.exit(1);
}

const profileFilter = getArg("profile");
const htmlOnly = hasFlag("html-only");
const siteUrl = getArg("site-url") ?? "http://localhost:4321";
const dbPath = process.env.DB_PATH ?? "data/leylibre.db";

// ── Derived dates ──

function weekToDateRange(w: string): { since: string; until: string } {
	const [yearStr, weekStr] = w.split("-W");
	const year = Number.parseInt(yearStr);
	const weekNum = Number.parseInt(weekStr);
	// ISO week: Monday of week 1 is the Monday closest to Jan 4
	const jan4 = new Date(year, 0, 4);
	const dayOfWeek = jan4.getDay() || 7; // 1=Mon..7=Sun
	const monday = new Date(jan4);
	monday.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	const fmt = (d: Date) => d.toISOString().slice(0, 10);
	return { since: fmt(monday), until: fmt(sunday) };
}

const { since, until } = weekToDateRange(week);
const weekNum = Number.parseInt(week.split("-W")[1]);
const yearNum = Number.parseInt(week.split("-W")[0]);
const weekLabel = `Semana ${weekNum}, ${yearNum}`;

// ── Paths ──

const ROOT = process.cwd();
const digestDir = join(
	ROOT,
	"data",
	"digests",
	yearNum.toString(),
	`W${weekNum}`,
);
const webDir = join(ROOT, "packages", "web", "public", "resumenes");
const templateDir = join(
	ROOT,
	".claude",
	"skills",
	"weekly-digest",
	"templates",
);

const webTemplate = readFileSync(join(templateDir, "web-page.html"), "utf-8");
const emailTemplate = readFileSync(join(templateDir, "email.html"), "utf-8");

// ── DB ──

const db = new Database(dbPath, { readonly: true });

interface ReformResult {
	norm_id: string;
	title: string;
	rank: string;
	status: string;
	date: string;
	source_id: string;
}

interface BlockDiff {
	block_id: string;
	title: string;
	change_type: "modified" | "new";
	previous_text: string;
	current_text: string;
}

function queryReforms(
	materias: string[],
	jurisdiction: string,
): ReformResult[] {
	if (materias.length === 0) return [];
	const placeholders = materias.map(() => "?").join(",");
	const jurClause =
		jurisdiction === "es"
			? "(n.source_url LIKE '%/eli/es/%' AND n.source_url NOT LIKE '%/eli/es-__/%')"
			: `n.source_url LIKE '%/eli/${jurisdiction}/%'`;

	return db
		.query<ReformResult, unknown[]>(
			`SELECT DISTINCT n.id as norm_id, n.title, n.rank, n.status, r.date, r.source_id
       FROM reforms r
       JOIN norms n ON n.id = r.norm_id
       JOIN materias m ON m.norm_id = r.norm_id
       WHERE r.date >= ? AND r.date <= ?
         AND m.materia IN (${placeholders})
         AND ${jurClause}
       ORDER BY r.date DESC`,
		)
		.all(since, until, ...materias);
}

function queryBlockDiffs(
	normId: string,
	sourceId: string,
	reformDate: string,
): BlockDiff[] {
	const blocks = db
		.query<{ block_id: string; title: string }, [string, string]>(
			`SELECT b.block_id, b.title
       FROM reform_blocks rb
       JOIN blocks b ON b.norm_id = rb.norm_id AND b.block_id = rb.block_id
       WHERE rb.reform_source_id = ? AND rb.norm_id = ?
       ORDER BY b.position`,
		)
		.all(sourceId, normId);

	const diffs: BlockDiff[] = [];
	for (const block of blocks) {
		if (!block.title) continue;
		const versions = db
			.query<{ date: string; text: string }, [string, string, string]>(
				`SELECT v.date, v.text
         FROM versions v
         WHERE v.norm_id = ? AND v.block_id = ? AND v.date <= ?
         ORDER BY v.date DESC
         LIMIT 2`,
			)
			.all(normId, block.block_id, reformDate);

		const truncate = (s: string, max = 500) =>
			s.length > max ? `${s.slice(0, max)}...` : s;

		if (versions.length === 0) continue;
		if (versions.length === 1) {
			diffs.push({
				block_id: block.block_id,
				title: block.title,
				change_type: "new",
				previous_text: "",
				current_text: truncate(versions[0].text),
			});
		} else {
			diffs.push({
				block_id: block.block_id,
				title: block.title,
				change_type: "modified",
				previous_text: truncate(versions[1].text),
				current_text: truncate(versions[0].text),
			});
		}
	}
	return diffs;
}

// ── YAML generation ──

function escapeYaml(s: string): string {
	if (!s) return '""';
	if (
		s.includes("\n") ||
		s.includes('"') ||
		s.includes(":") ||
		s.includes("#")
	) {
		return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
	}
	return `"${s}"`;
}

interface DigestReform {
	id: string;
	title: string;
	rank: string;
	date: string;
	source_id: string;
	headline: string;
	summary: string;
	relevance: string;
	confidence: string;
	affected_blocks: BlockDiff[];
}

interface DigestData {
	week: string;
	profile: ThematicProfile;
	jurisdiction: string;
	generated_at: string;
	summary: string;
	reforms: DigestReform[];
}

function generateYaml(profile: ThematicProfile): DigestData {
	const reforms = queryReforms(profile.materias, "es");

	const digestReforms: DigestReform[] = reforms.map((r) => {
		const blocks = queryBlockDiffs(r.norm_id, r.source_id, r.date);
		return {
			id: r.norm_id,
			title: r.title,
			rank: r.rank,
			date: r.date,
			source_id: r.source_id,
			headline: "", // filled by AI later
			summary: "", // filled by AI later
			relevance: "", // filled by AI later
			confidence: "", // filled by AI later
			affected_blocks: blocks,
		};
	});

	return {
		week,
		profile,
		jurisdiction: "es",
		generated_at: new Date().toISOString(),
		summary: "", // filled by AI later
		reforms: digestReforms,
	};
}

function writeYaml(data: DigestData): string {
	const p = data.profile;
	const lines: string[] = [
		`week: ${escapeYaml(data.week)}`,
		"profile:",
		`  id: ${escapeYaml(p.id)}`,
		`  name: ${escapeYaml(p.name)}`,
		`  icon: ${escapeYaml(p.icon)}`,
		`  description: ${escapeYaml(p.description)}`,
		`jurisdiction: ${escapeYaml(data.jurisdiction)}`,
		`generated_at: ${escapeYaml(data.generated_at)}`,
		`summary: ${escapeYaml(data.summary)}`,
		"reforms:",
	];

	for (const r of data.reforms) {
		lines.push(`  - id: ${escapeYaml(r.id)}`);
		lines.push(`    title: ${escapeYaml(r.title)}`);
		lines.push(`    rank: ${escapeYaml(r.rank)}`);
		lines.push(`    date: ${escapeYaml(r.date)}`);
		lines.push(`    source_id: ${escapeYaml(r.source_id)}`);
		lines.push(`    headline: ${escapeYaml(r.headline)}`);
		lines.push(`    summary: ${escapeYaml(r.summary)}`);
		lines.push(`    relevance: ${escapeYaml(r.relevance)}`);
		lines.push(`    confidence: ${escapeYaml(r.confidence)}`);
		lines.push("    affected_blocks:");
		for (const b of r.affected_blocks) {
			lines.push(`      - block_id: ${escapeYaml(b.block_id)}`);
			lines.push(`        title: ${escapeYaml(b.title)}`);
			lines.push(`        change_type: ${b.change_type}`);
			lines.push(`        previous_text: ${escapeYaml(b.previous_text)}`);
			lines.push(`        current_text: ${escapeYaml(b.current_text)}`);
		}
		if (r.affected_blocks.length === 0) {
			lines.push("      []");
		}
	}

	if (data.reforms.length === 0) {
		lines[lines.length - 1] = "reforms: []";
	}

	return lines.join("\n");
}

// ── Simple YAML parser (reads our own output) ──

function parseDigestYaml(content: string): DigestData {
	// Parse enough to extract reforms with headline/summary/relevance for HTML rendering
	const reforms: DigestReform[] = [];
	let summary = "";
	let profileName = "";
	let profileIcon = "";
	let profileId = "";
	let profileDesc = "";

	// Extract top-level summary
	const summaryMatch = content.match(/^summary: "(.*)"$/m);
	if (summaryMatch)
		summary = summaryMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');

	// Extract profile
	const nameMatch = content.match(/^\s+name: "(.*)"$/m);
	if (nameMatch) profileName = nameMatch[1];
	const iconMatch = content.match(/^\s+icon: "(.*)"$/m);
	if (iconMatch) profileIcon = iconMatch[1];
	const idMatch = content.match(/^\s+id: "(.*)"$/m);
	if (idMatch) profileId = idMatch[1];
	const descMatch = content.match(/^\s+description: "(.*)"$/m);
	if (descMatch) profileDesc = descMatch[1];

	// Extract reforms
	const reformBlocks = content.split(/\n {2}- id: /);
	for (let i = 1; i < reformBlocks.length; i++) {
		const block = `  - id: ${reformBlocks[i]}`;
		const get = (key: string) => {
			const m = block.match(new RegExp(`^\\s+${key}: "(.*)"$`, "m"));
			return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
		};
		reforms.push({
			id: get("id"),
			title: get("title"),
			rank: get("rank"),
			date: get("date"),
			source_id: get("source_id"),
			headline: get("headline"),
			summary: get("summary"),
			relevance: get("relevance") || "medium",
			confidence: get("confidence") || "low",
			affected_blocks: [], // not needed for HTML generation
		});
	}

	return {
		week,
		profile: {
			id: profileId,
			name: profileName,
			icon: profileIcon,
			description: profileDesc,
			materias: [],
		},
		jurisdiction: "es",
		generated_at: new Date().toISOString(),
		summary,
		reforms,
	};
}

// ── HTML generation ──

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatDate(iso: string): string {
	const d = new Date(iso);
	const months = [
		"ene",
		"feb",
		"mar",
		"abr",
		"may",
		"jun",
		"jul",
		"ago",
		"sep",
		"oct",
		"nov",
		"dic",
	];
	return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function generateWebHtml(data: DigestData): string {
	const high = data.reforms.filter(
		(r) => r.relevance === "high" || r.relevance === "medium",
	);
	const low = data.reforms.filter((r) => r.relevance === "low");
	// If no relevance set yet (pre-AI), show all as high
	const showAll = data.reforms.every((r) => !r.relevance);
	const mainReforms = showAll ? data.reforms : high;
	const lowReforms = showAll ? [] : low;

	const highHtml = mainReforms
		.map(
			(r) => `
    <article class="reform reform-${r.relevance || "medium"}">
      <div class="reform-date">${escapeHtml(r.date)}</div>
      <h3>${escapeHtml(r.headline || r.title)}</h3>
      <p>${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
      <a href="${siteUrl}/laws/${encodeURIComponent(r.id)}" class="reform-link">Ver ley completa →</a>
    </article>`,
		)
		.join("\n");

	let lowHtml = "";
	if (lowReforms.length > 0) {
		const items = lowReforms
			.map(
				(r) =>
					`      <div class="also-item">• ${escapeHtml(r.headline || r.title)}</div>`,
			)
			.join("\n");
		lowHtml = `
    <div class="also-section">
      <h2>Tambien esta semana</h2>
${items}
    </div>`;
	}

	const now = new Date();
	const generatedAt = formatDate(now.toISOString().slice(0, 10));

	return webTemplate
		.replaceAll("{{TITLE}}", `Resumen semanal — ${data.profile.name} (${week})`)
		.replaceAll("{{PROFILE_NAME}}", escapeHtml(data.profile.name))
		.replaceAll("{{PROFILE_ICON}}", data.profile.icon)
		.replaceAll("{{WEEK}}", week)
		.replaceAll("{{WEEK_LABEL}}", weekLabel)
		.replaceAll("{{GENERATED_AT}}", generatedAt)
		.replaceAll(
			"{{SUMMARY}}",
			escapeHtml(
				data.summary ||
					`${data.reforms.length} cambios legislativos esta semana.`,
			),
		)
		.replaceAll("{{HIGH_REFORMS}}", highHtml)
		.replaceAll("{{LOW_REFORMS}}", lowHtml)
		.replaceAll("{{REFORM_COUNT}}", String(data.reforms.length));
}

function generateEmailHtml(data: DigestData): string {
	const high = data.reforms.filter(
		(r) => r.relevance === "high" || r.relevance === "medium",
	);
	const low = data.reforms.filter((r) => r.relevance === "low");
	const showAll = data.reforms.every((r) => !r.relevance);
	const mainReforms = showAll ? data.reforms : high;
	const lowReforms = showAll ? [] : low;

	const highRows = mainReforms
		.map(
			(r) => `
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #e8ecf0;">
                    <table cellpadding="0" cellspacing="0" width="100%"><tr><td>
                      <p style="font-size: 12px; color: #6b8299; font-family: 'Courier New', monospace; margin: 0 0 4px;">${escapeHtml(r.date)}</p>
                      <p style="font-family: Georgia, 'Times New Roman', serif; font-size: 17px; font-weight: 700; color: #1a365d; margin: 0 0 8px; line-height: 1.3;">${escapeHtml(r.headline || r.title)}</p>
                      <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #4a6078; line-height: 1.65; margin: 0 0 8px;">${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
                      <a href="${siteUrl}/laws/${encodeURIComponent(r.id)}" style="font-size: 13px; color: #2b5797; text-decoration: none;">Ver ley completa &#8594;</a>
                    </td></tr></table>
                  </td>
                </tr>`,
		)
		.join("\n");

	let lowSection = "";
	if (lowReforms.length > 0) {
		const items = lowReforms
			.map((r) => `&#8226; ${escapeHtml(r.headline || r.title)}`)
			.join("<br/>\n                    ");
		lowSection = `
              <table cellpadding="0" cellspacing="0" width="100%" style="margin-top: 24px;">
                <tr>
                  <td style="padding-top: 20px; border-top: 1px solid #e8ecf0;">
                    <p style="font-family: Georgia, 'Times New Roman', serif; font-size: 14px; font-weight: 700; color: #6b8299; margin: 0 0 8px;">Tambien esta semana</p>
                    <p style="font-size: 13px; color: #6b8299; line-height: 2; margin: 0;">
                    ${items}
                    </p>
                  </td>
                </tr>
              </table>`;
	}

	const count = data.reforms.length;
	const suffix = count === 1 ? "" : "s";
	const webUrl = `${siteUrl}/resumenes/${data.profile.id}/${week}.html`;

	return emailTemplate
		.replaceAll("{{SITE_URL}}", siteUrl)
		.replaceAll("{{PROFILE_NAME}}", escapeHtml(data.profile.name))
		.replaceAll("{{PROFILE_ICON}}", data.profile.icon)
		.replaceAll("{{WEEK_LABEL}}", weekLabel)
		.replaceAll(
			"{{SUMMARY}}",
			escapeHtml(data.summary || `${count} cambios legislativos esta semana.`),
		)
		.replaceAll("{{HIGH_REFORMS}}", highRows)
		.replaceAll("{{LOW_REFORMS}}", lowSection)
		.replaceAll("{{REFORM_COUNT}}", String(count))
		.replaceAll("{{REFORM_COUNT_SUFFIX}}", suffix)
		.replaceAll("{{WEB_URL}}", webUrl)
		.replaceAll("{{PREFS_URL}}", `${siteUrl}/alertas`)
		.replaceAll(
			"{{UNSUB_URL}}",
			`${siteUrl}/alertas/cancelar?token=SUBSCRIBER_TOKEN`,
		);
}

// ── Main ──

const profiles = profileFilter
	? PROFILES.filter((p) => p.id === profileFilter)
	: PROFILES;

if (profiles.length === 0) {
	console.error(`Unknown profile: ${profileFilter}`);
	process.exit(1);
}

mkdirSync(digestDir, { recursive: true });

console.log(`Generating digests for ${week} (${since} → ${until})`);
console.log(`Profiles: ${profiles.map((p) => p.id).join(", ")}`);
console.log(
	`Mode: ${htmlOnly ? "HTML-only (from existing YAMLs)" : "Full (YAML + HTML)"}\n`,
);

for (const profile of profiles) {
	const yamlPath = join(digestDir, `${profile.id}.yaml`);
	const webPath = join(webDir, profile.id, `${week}.html`);
	const emailPath = join(digestDir, `${profile.id}-email.html`);

	let data: DigestData;

	if (htmlOnly) {
		// Read existing YAML
		if (!existsSync(yamlPath)) {
			console.log(`  ${profile.icon} ${profile.name}: no YAML found, skipping`);
			continue;
		}
		const content = readFileSync(yamlPath, "utf-8");
		data = parseDigestYaml(content);
	} else {
		// Generate YAML from DB
		data = generateYaml(profile);
		const yamlContent = writeYaml(data);
		writeFileSync(yamlPath, yamlContent);
	}

	if (data.reforms.length === 0) {
		console.log(`  ${profile.icon} ${profile.name}: 0 reforms — YAML only`);
		continue;
	}

	// Generate HTML
	mkdirSync(dirname(webPath), { recursive: true });
	writeFileSync(webPath, generateWebHtml(data));
	writeFileSync(emailPath, generateEmailHtml(data));

	const hasSummaries = data.reforms.some((r) => r.headline);
	const tag = hasSummaries ? "" : " [needs AI summaries]";
	console.log(
		`  ${profile.icon} ${profile.name}: ${data.reforms.length} reforms → YAML + web + email${tag}`,
	);
}

console.log("\nDone.");
console.log(`  YAML:  ${digestDir}/`);
console.log(`  Web:   ${webDir}/`);
console.log(`  Email: ${digestDir}/*-email.html`);
if (!htmlOnly) {
	console.log(
		"\nNext step: run /weekly-digest to add AI summaries, then --html-only to regenerate HTML.",
	);
}

db.close();
