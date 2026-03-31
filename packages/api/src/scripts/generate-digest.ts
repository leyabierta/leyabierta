/**
 * Programmatic weekly digest generator.
 *
 * Generates YAML (source of truth), web HTML, and email HTML for each profile.
 * NO AI involved — only DB queries and template rendering.
 * The citizen-writer AI step is separate (via /weekly-digest skill).
 *
 * Architecture: SQL gets ALL reforms (no materia filtering). AI decides relevance
 * per profile using persona descriptions. This script generates the raw data;
 * the AI enriches it with relevance scoring and citizen summaries.
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
import yaml from "js-yaml";
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
	const year = Number.parseInt(yearStr, 10);
	const weekNum = Number.parseInt(weekStr, 10);
	const jan4 = new Date(year, 0, 4);
	const dayOfWeek = jan4.getDay() || 7;
	const monday = new Date(jan4);
	monday.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	const fmt = (d: Date) => d.toISOString().slice(0, 10);
	return { since: fmt(monday), until: fmt(sunday) };
}

const { since, until } = weekToDateRange(week);
const weekNum = Number.parseInt(week.split("-W")[1], 10);
const yearNum = Number.parseInt(week.split("-W")[0], 10);
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

/**
 * Query ALL reforms for the week, filtered only by jurisdiction.
 * No materia filtering — the AI decides relevance per profile.
 */
function queryAllReforms(jurisdiction: string): ReformResult[] {
	const jurClause =
		jurisdiction === "es"
			? "(n.source_url LIKE '%/eli/es/%' AND n.source_url NOT LIKE '%/eli/es-__/%')"
			: `n.source_url LIKE '%/eli/${jurisdiction}/%'`;

	return db
		.query<ReformResult, [string, string]>(
			`SELECT DISTINCT n.id as norm_id, n.title, n.rank, n.status, r.date, r.source_id
       FROM reforms r
       JOIN norms n ON n.id = r.norm_id
       WHERE r.date >= ? AND r.date <= ?
         AND ${jurClause}
       ORDER BY r.date DESC`,
		)
		.all(since, until);
}

function queryBlockDiffs(
	normId: string,
	sourceId: string,
	reformDate: string,
	maxTextLen = 500,
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

		const truncate = (s: string) =>
			s.length > maxTextLen ? `${s.slice(0, maxTextLen)}...` : s;

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

// ── Data types ──

interface DigestReform {
	id: string;
	title: string;
	rank: string;
	date: string;
	source_id: string;
	relevant: boolean | null;
	te_afecta_porque: string;
	headline: string;
	summary: string;
	confidence: string;
	affected_blocks: BlockDiff[];
}

interface DigestData {
	week: string;
	profile: {
		id: string;
		name: string;
		icon: string;
		description: string;
		persona: string;
	};
	jurisdiction: string;
	generated_at: string;
	summary: string;
	reforms: DigestReform[];
}

// ── YAML generation (using js-yaml) ──

function generateDigestData(
	profile: ThematicProfile,
	maxTextLen = 500,
): DigestData {
	const reforms = queryAllReforms("es");

	const digestReforms: DigestReform[] = reforms.map((r) => {
		const blocks = queryBlockDiffs(r.norm_id, r.source_id, r.date, maxTextLen);
		return {
			id: r.norm_id,
			title: r.title,
			rank: r.rank,
			date: r.date,
			source_id: r.source_id,
			relevant: null, // decided by AI
			te_afecta_porque: "", // decided by AI
			headline: "", // decided by AI
			summary: "", // decided by AI
			confidence: "", // decided by AI
			affected_blocks: blocks,
		};
	});

	return {
		week,
		profile: {
			id: profile.id,
			name: profile.name,
			icon: profile.icon,
			description: profile.description,
			persona: profile.persona,
		},
		jurisdiction: "es",
		generated_at: new Date().toISOString(),
		summary: "",
		reforms: digestReforms,
	};
}

function serializeYaml(data: DigestData): string {
	return yaml.dump(data, {
		lineWidth: -1, // no wrapping
		noRefs: true,
		quotingType: '"',
		forceQuotes: false,
	});
}

function parseDigestYaml(content: string): DigestData {
	const parsed = yaml.load(content) as DigestData;
	// Ensure reforms have defaults for fields that may be missing (backwards compat)
	if (parsed.reforms) {
		for (const r of parsed.reforms) {
			r.relevant = r.relevant ?? null;
			r.te_afecta_porque = r.te_afecta_porque ?? "";
			r.headline = r.headline ?? "";
			r.summary = r.summary ?? "";
			r.confidence = r.confidence ?? "";
			r.affected_blocks = r.affected_blocks ?? [];
		}
	}
	return parsed;
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

/**
 * Get reforms to display in HTML. Only relevant reforms (or all if AI hasn't run yet).
 */
function getDisplayReforms(data: DigestData): DigestReform[] {
	const aiHasRun = data.reforms.some((r) => r.relevant !== null);
	if (!aiHasRun) return data.reforms; // pre-AI: show all with titles as placeholders
	return data.reforms.filter((r) => r.relevant === true);
}

function generateWebHtml(data: DigestData): string {
	const reforms = getDisplayReforms(data);

	const reformsHtml = reforms
		.map((r) => {
			const teAfecta = r.te_afecta_porque
				? `\n      <p class="te-afecta"><strong>Te afecta porque:</strong> ${escapeHtml(r.te_afecta_porque)}</p>`
				: "";
			return `
    <article class="reform">
      <div class="reform-date">${escapeHtml(r.date)}</div>
      <h3>${escapeHtml(r.headline || r.title)}</h3>
      <p>${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>${teAfecta}
      <a href="${siteUrl}/laws/${encodeURIComponent(r.id)}" class="reform-link">Ver ley completa →</a>
    </article>`;
		})
		.join("\n");

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
				data.summary || `${reforms.length} cambios legislativos esta semana.`,
			),
		)
		.replaceAll("{{HIGH_REFORMS}}", reformsHtml)
		.replaceAll("{{LOW_REFORMS}}", "") // no more low section
		.replaceAll("{{REFORM_COUNT}}", String(reforms.length));
}

function generateEmailHtml(data: DigestData): string {
	const reforms = getDisplayReforms(data);

	const reformRows = reforms
		.map((r) => {
			const teAfecta = r.te_afecta_porque
				? `<p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #1a7a4e; font-style: italic; line-height: 1.5; margin: 0 0 8px;"><strong>Te afecta porque:</strong> ${escapeHtml(r.te_afecta_porque)}</p>`
				: "";
			return `
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #e8ecf0;">
                    <table cellpadding="0" cellspacing="0" width="100%"><tr><td>
                      <p style="font-size: 12px; color: #6b8299; font-family: 'Courier New', monospace; margin: 0 0 4px;">${escapeHtml(r.date)}</p>
                      <p style="font-family: Georgia, 'Times New Roman', serif; font-size: 17px; font-weight: 700; color: #1a365d; margin: 0 0 8px; line-height: 1.3;">${escapeHtml(r.headline || r.title)}</p>
                      <p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #4a6078; line-height: 1.65; margin: 0 0 8px;">${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
                      ${teAfecta}
                      <a href="${siteUrl}/laws/${encodeURIComponent(r.id)}" style="font-size: 13px; color: #2b5797; text-decoration: none;">Ver ley completa &#8594;</a>
                    </td></tr></table>
                  </td>
                </tr>`;
		})
		.join("\n");

	const count = reforms.length;
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
		.replaceAll("{{HIGH_REFORMS}}", reformRows)
		.replaceAll("{{LOW_REFORMS}}", "") // no more low section
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

// Query ALL reforms once (shared across all profiles)
let allReformsCount = 0;
if (!htmlOnly) {
	const testReforms = queryAllReforms("es");
	allReformsCount = testReforms.length;
	console.log(`Total reforms this week: ${allReformsCount}\n`);
}

for (const profile of profiles) {
	const yamlPath = join(digestDir, `${profile.id}.yaml`);
	const webPath = join(webDir, profile.id, `${week}.html`);
	const emailPath = join(digestDir, `${profile.id}-email.html`);

	let data: DigestData;

	if (htmlOnly) {
		if (!existsSync(yamlPath)) {
			console.log(`  ${profile.icon} ${profile.name}: no YAML found, skipping`);
			continue;
		}
		const content = readFileSync(yamlPath, "utf-8");
		data = parseDigestYaml(content);
	} else {
		data = generateDigestData(profile);
		writeFileSync(yamlPath, serializeYaml(data));
	}

	// For HTML: only render if there are displayable reforms
	const displayReforms = getDisplayReforms(data);
	if (displayReforms.length === 0 && data.reforms.length === 0) {
		console.log(`  ${profile.icon} ${profile.name}: 0 reforms — YAML only`);
		continue;
	}

	mkdirSync(dirname(webPath), { recursive: true });
	writeFileSync(webPath, generateWebHtml(data));
	writeFileSync(emailPath, generateEmailHtml(data));

	const aiStatus = data.reforms.some((r) => r.relevant !== null)
		? `${displayReforms.length} relevant of ${data.reforms.length}`
		: `${data.reforms.length} total [needs AI relevance scoring]`;
	console.log(
		`  ${profile.icon} ${profile.name}: ${aiStatus} → YAML + web + email`,
	);
}

console.log("\nDone.");
console.log(`  YAML:  ${digestDir}/`);
console.log(`  Web:   ${webDir}/`);
console.log(`  Email: ${digestDir}/*-email.html`);
if (!htmlOnly) {
	console.log(
		"\nNext step: run /weekly-digest to add AI relevance + summaries, then --html-only to regenerate HTML.",
	);
}

db.close();
