/**
 * Weekly digest email sender — sends AI-scored digests to confirmed subscribers.
 *
 * Reads the latest digest from the DB for each subscriber's profile,
 * uses the AI-scored reforms (relevant=true) to build personalized emails.
 * Subscribers get the same content as the web pages.
 *
 * Usage:
 *   bun run packages/api/src/scripts/send-digest.ts
 *   bun run packages/api/src/scripts/send-digest.ts --week 2026-W13
 *   bun run packages/api/src/scripts/send-digest.ts --preview
 *   bun run packages/api/src/scripts/send-digest.ts --dry-run
 *
 * Flags:
 *   --week YYYY-WNN  Specific week to send (default: latest available per profile)
 *   --preview        Print digest HTML to stdout instead of sending
 *   --dry-run        Log what would be sent without actually sending
 */

import { Database } from "bun:sqlite";
import { createSchema } from "@leyabierta/pipeline";
import { getProfileById, PROFILES } from "../data/profiles.ts";
import { DbService } from "../services/db.ts";
import { sendDigestEmail } from "../services/email.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const SITE_URL = process.env.SITE_URL ?? "https://leyabierta.es";

const args = process.argv.slice(2);
const preview = args.includes("--preview");
const dryRun = args.includes("--dry-run");
function getArg(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}
const weekOverride = getArg("week");

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);

interface DigestReform {
	id: string;
	title: string;
	rank: string;
	date: string;
	relevant: boolean | null;
	headline: string;
	summary: string;
	te_afecta_porque: string;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function buildEmailFromDigest(
	profileName: string,
	profileIcon: string,
	week: string,
	digestSummary: string,
	reforms: DigestReform[],
	unsubToken: string,
): string {
	const relevant = reforms.filter((r) => r.relevant === true);
	if (relevant.length === 0) return "";

	const weekNum = week.split("-W")[1];
	const year = week.split("-W")[0];
	const weekLabel = `Semana ${weekNum}, ${year}`;

	const reformRows = relevant
		.map(
			(r) => `
    <tr>
      <td style="padding: 16px 0; border-bottom: 1px solid #e8ecf0;">
        <p style="font-size: 12px; color: #6b8299; font-family: 'Courier New', monospace; margin: 0 0 4px;">${escapeHtml(r.date)}</p>
        <p style="font-family: Georgia, 'Times New Roman', serif; font-size: 16px; font-weight: 700; color: #1a365d; margin: 0 0 6px; line-height: 1.3;">${escapeHtml(r.headline || r.title)}</p>
        <p style="font-family: -apple-system, sans-serif; font-size: 14px; color: #4a6078; line-height: 1.6; margin: 0 0 6px;">${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
        ${r.te_afecta_porque ? `<p style="font-size: 13px; color: #1a7a4e; font-style: italic; margin: 0 0 6px;"><strong>Te afecta porque:</strong> ${escapeHtml(r.te_afecta_porque)}</p>` : ""}
        <a href="${SITE_URL}/laws/${encodeURIComponent(r.id)}" style="font-size: 13px; color: #2b5797; text-decoration: none;">Ver ley completa &#8594;</a>
      </td>
    </tr>`,
		)
		.join("\n");

	const cancelUrl = `${SITE_URL}/alertas/cancelar?token=${unsubToken}`;
	const prefsUrl = `${SITE_URL}/alertas`;
	const webUrl = `${SITE_URL}/resumenes/${encodeURIComponent(profileName.toLowerCase())}/${week}`;

	return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #0b1120;">
  <h2 style="font-family: Georgia, serif; color: #1a365d; margin-bottom: 4px;">${profileIcon} Tu resumen semanal</h2>
  <p style="color: #4a6078; margin-top: 4px; margin-bottom: 16px; font-size: 14px;">
    <strong>${escapeHtml(profileName)}</strong> · ${weekLabel}
  </p>
  ${digestSummary ? `<p style="color: #4a6078; line-height: 1.6; font-size: 15px; padding: 12px; background: #f0f4f8; border-radius: 6px; border-left: 3px solid #2b5797;">${escapeHtml(digestSummary)}</p>` : ""}
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    ${reformRows}
  </table>
  <p style="margin: 24px 0; text-align: center;">
    <a href="${webUrl}" style="display: inline-block; padding: 10px 20px; background: #1a365d; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px;">Ver en Ley Abierta</a>
  </p>
  <hr style="border: none; border-top: 1px solid #e8ecf0; margin: 24px 0;" />
  <p style="color: #6b8299; font-size: 12px; line-height: 1.5;">
    Recibes esto porque sigues el perfil "${escapeHtml(profileName)}".
    <a href="${prefsUrl}" style="color: #2b5797;">Cambiar preferencias</a> ·
    <a href="${cancelUrl}" style="color: #2b5797;">Cancelar suscripcion</a>
  </p>
</body>
</html>`;
}

// ── Preview mode ──

if (preview) {
	for (const profile of PROFILES) {
		const weeks = dbService.listDigestsForProfile(profile.id);
		const targetWeek = weekOverride ?? weeks[0]?.week;
		if (!targetWeek) {
			console.log(`\n=== ${profile.name}: no digests found ===`);
			continue;
		}

		const digest = dbService.getDigest(profile.id, targetWeek);
		if (!digest) continue;

		let reforms: DigestReform[] = [];
		try {
			const parsed = JSON.parse(digest.data);
			reforms = parsed.reforms ?? [];
		} catch {
			continue;
		}

		const relevant = reforms.filter((r) => r.relevant === true);
		console.log(
			`\n=== ${profile.name} (${targetWeek}, ${relevant.length} relevant of ${reforms.length}) ===`,
		);

		if (relevant.length === 0) {
			console.log("No relevant reforms for this profile.");
			continue;
		}

		const html = buildEmailFromDigest(
			profile.name,
			profile.icon,
			targetWeek,
			digest.summary,
			reforms,
			"preview-token",
		);
		console.log(html);
	}
	db.close();
	process.exit(0);
}

// ── Send mode ──

const subscribers = dbService.getConfirmedSubscribers();
console.log(`Found ${subscribers.length} confirmed subscribers.`);

// Group by profile + jurisdiction
const groups = new Map<string, typeof subscribers>();
for (const sub of subscribers) {
	const key = `${sub.profile_id}:${sub.jurisdiction}`;
	const group = groups.get(key);
	if (group) {
		group.push(sub);
	} else {
		groups.set(key, [sub]);
	}
}

let sent = 0;
let skipped = 0;

for (const [key, subs] of groups) {
	const [profileId, jurisdiction] = key.split(":");
	const profile = getProfileById(profileId!);
	if (!profile) continue;

	// Find the target week's digest
	const weeks = dbService.listDigestsForProfile(profileId!);
	const targetWeek = weekOverride ?? weeks[0]?.week;
	if (!targetWeek) {
		skipped += subs.length;
		continue;
	}

	const digest = dbService.getDigest(profileId!, targetWeek, jurisdiction);
	if (!digest) {
		skipped += subs.length;
		continue;
	}

	let reforms: DigestReform[] = [];
	try {
		const parsed = JSON.parse(digest.data);
		reforms = parsed.reforms ?? [];
	} catch {
		skipped += subs.length;
		continue;
	}

	const relevant = reforms.filter((r) => r.relevant === true);
	if (relevant.length === 0) {
		skipped += subs.length;
		continue;
	}

	for (const sub of subs) {
		const html = buildEmailFromDigest(
			profile.name,
			profile.icon,
			targetWeek,
			digest.summary,
			reforms,
			sub.token,
		);

		if (!html) {
			skipped++;
			continue;
		}

		if (dryRun) {
			console.log(
				`[dry-run] Would send to ${sub.email}: ${profile.name} (${targetWeek}), ${relevant.length} relevant reforms`,
			);
			sent++;
			continue;
		}

		const jurisdictionLabel = jurisdiction === "es" ? "Estatal" : jurisdiction!;
		const ok = await sendDigestEmail(
			sub.email,
			profile.name,
			jurisdictionLabel,
			html,
		);
		if (ok) sent++;
		else console.error(`Failed: ${sub.email}`);
	}
}

console.log(`Done. Sent: ${sent}, Skipped (no relevant reforms): ${skipped}`);
db.close();
