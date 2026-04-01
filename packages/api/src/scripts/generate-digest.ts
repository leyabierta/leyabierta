/**
 * Weekly digest generator — writes to SQLite DB.
 *
 * Generates digest data for each profile and stores in the digests table.
 * Optionally generates email HTML to filesystem for send-digest.
 * NO AI involved — only DB queries. The AI enrichment step is separate
 * (run-weekly-digest.ts Phase 2).
 *
 * Architecture: SQL gets ALL reforms (no materia filtering). AI decides relevance
 * per profile using persona descriptions.
 *
 * Usage:
 *   bun run packages/api/src/scripts/generate-digest.ts --week 2026-W13
 *   bun run packages/api/src/scripts/generate-digest.ts --week 2026-W13 --profile sanitario
 *   bun run packages/api/src/scripts/generate-digest.ts --week 2026-W13 --email-html
 *   bun run packages/api/src/scripts/generate-digest.ts --week 2026-W13 --from-db
 *
 * Flags:
 *   --week YYYY-WNN    Required. ISO week to generate.
 *   --profile ID       Only generate for this profile (default: all 8).
 *   --email-html       Also write email HTML files to data/digests/ (for send-digest).
 *   --from-db          Read existing data from DB (preserves AI scores), only generate email HTML.
 *   --site-url URL     Base URL for links (default: http://localhost:4321).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSchema } from "@leyabierta/pipeline";
import { PROFILES, type ThematicProfile } from "../data/profiles.ts";
import { DbService } from "../services/db.ts";

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
const emailHtml = hasFlag("email-html");
const fromDb = hasFlag("from-db");
const siteUrl = getArg("site-url") ?? "http://localhost:4321";
const dbPath = process.env.DB_PATH ?? "data/leyabierta.db";

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

// ── Paths (for email HTML only) ──

const ROOT = process.cwd();
const digestDir = join(
	ROOT,
	"data",
	"digests",
	yearNum.toString(),
	`W${weekNum}`,
);
const templateDir = join(
	ROOT,
	".claude",
	"skills",
	"weekly-digest",
	"templates",
);

// ── DB ──

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);

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

export interface DigestReform {
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

export interface DigestData {
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

// ── Generation ──

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
			relevant: null,
			te_afecta_porque: "",
			headline: "",
			summary: "",
			confidence: "",
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

// ── Email HTML generation ──

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function getDisplayReforms(data: DigestData): DigestReform[] {
	const aiHasRun = data.reforms.some((r) => r.relevant !== null);
	if (!aiHasRun) return data.reforms;
	return data.reforms.filter((r) => r.relevant === true);
}

function generateEmailHtml(data: DigestData, template: string): string {
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
	const webUrl = `${siteUrl}/resumenes/${data.profile.id}/${week}`;

	return template
		.replaceAll("{{SITE_URL}}", siteUrl)
		.replaceAll("{{PROFILE_NAME}}", escapeHtml(data.profile.name))
		.replaceAll("{{PROFILE_ICON}}", data.profile.icon)
		.replaceAll("{{WEEK_LABEL}}", weekLabel)
		.replaceAll(
			"{{SUMMARY}}",
			escapeHtml(data.summary || `${count} cambios legislativos esta semana.`),
		)
		.replaceAll("{{HIGH_REFORMS}}", reformRows)
		.replaceAll("{{LOW_REFORMS}}", "")
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

const mode = fromDb
	? "email HTML from DB"
	: `DB write${emailHtml ? " + email HTML" : ""}`;
console.log(`Generating digests for ${week} (${since} → ${until})`);
console.log(`Profiles: ${profiles.map((p) => p.id).join(", ")}`);
console.log(`Mode: ${mode}\n`);

if (!fromDb) {
	const testReforms = queryAllReforms("es");
	console.log(`Total reforms this week: ${testReforms.length}\n`);
}

for (const profile of profiles) {
	if (fromDb) {
		// Read existing data from DB (preserves AI scores) → generate email HTML only
		const existing = dbService.getDigest(profile.id, week);
		if (!existing) {
			console.log(`  ${profile.icon} ${profile.name}: not in DB, skipping`);
			continue;
		}

		let reforms: DigestReform[] = [];
		try {
			const parsed = JSON.parse(existing.data);
			reforms = parsed.reforms ?? [];
		} catch {
			console.log(
				`  ${profile.icon} ${profile.name}: malformed data, skipping`,
			);
			continue;
		}

		const data: DigestData = {
			week: existing.week,
			profile: {
				id: profile.id,
				name: profile.name,
				icon: profile.icon,
				description: profile.description,
				persona: profile.persona,
			},
			jurisdiction: existing.jurisdiction,
			generated_at: existing.generated_at,
			summary: existing.summary,
			reforms,
		};

		mkdirSync(digestDir, { recursive: true });
		const emailPath = join(digestDir, `${profile.id}-email.html`);
		const templatePath = join(templateDir, "email.html");
		if (existsSync(templatePath)) {
			const template = readFileSync(templatePath, "utf-8");
			const displayReforms = getDisplayReforms(data);
			if (displayReforms.length > 0 || reforms.length > 0) {
				writeFileSync(emailPath, generateEmailHtml(data, template));
			}
		}

		const relevant = reforms.filter((r) => r.relevant === true).length;
		console.log(
			`  ${profile.icon} ${profile.name}: ${relevant}/${reforms.length} relevant → email HTML`,
		);
	} else {
		// Generate fresh data from DB queries → write to DB
		const data = generateDigestData(profile);

		dbService.upsertDigest(
			data.profile.id,
			data.week,
			data.jurisdiction,
			data.summary,
			data.generated_at,
			JSON.stringify({ reforms: data.reforms }),
		);

		// Optionally write email HTML
		if (emailHtml) {
			mkdirSync(digestDir, { recursive: true });
			const emailPath = join(digestDir, `${profile.id}-email.html`);
			const templatePath = join(templateDir, "email.html");
			if (existsSync(templatePath)) {
				const template = readFileSync(templatePath, "utf-8");
				const displayReforms = getDisplayReforms(data);
				if (displayReforms.length > 0 || data.reforms.length > 0) {
					writeFileSync(emailPath, generateEmailHtml(data, template));
				}
			}
		}

		console.log(
			`  ${profile.icon} ${profile.name}: ${data.reforms.length} reforms → DB`,
		);
	}
}

console.log("\nDone. Digests written to SQLite.");
db.close();
