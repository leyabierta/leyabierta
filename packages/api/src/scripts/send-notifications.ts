/**
 * Event-driven notification sender.
 *
 * Finds reforms with AI summaries that haven't been notified yet,
 * matches them to subscribers by materias + jurisdiction, and sends
 * focused emails via Resend. $0 per email — no LLM in the send path.
 *
 * "Oirás poco de nosotros, pero cuando oigas será importante."
 *
 * Usage:
 *   bun run packages/api/src/scripts/send-notifications.ts
 *   bun run packages/api/src/scripts/send-notifications.ts --mark-existing
 *   bun run packages/api/src/scripts/send-notifications.ts --dry-run
 *   bun run packages/api/src/scripts/send-notifications.ts --preview --materias 'IRPF,Empleo' --jurisdiction es-vc
 */

import { Database } from "bun:sqlite";
import { createSchema } from "@leyabierta/pipeline";
import { Resend } from "resend";
import { DbService } from "../services/db.ts";
import {
	buildUnsubscribeUrl,
	sendNotificationEmail,
} from "../services/email.ts";

// ── Config ──────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const SITE_URL = process.env.SITE_URL ?? "https://leyabierta.es";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID ?? "";
const MAX_REFORMS_PER_EMAIL = 10;

const args = process.argv.slice(2);
const markExisting = args.includes("--mark-existing");
const previewMode = args.includes("--preview");
const dryRun = args.includes("--dry-run");

function getArg(name: string): string | undefined {
	const idx = args.indexOf(`--${name}`);
	return idx >= 0 ? args[idx + 1] : undefined;
}

// ── DB setup ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);

// ── Mark existing mode ──────────────────────────────────────────────────

if (markExisting) {
	const count = dbService.markAllReformSummariesNotified();
	console.log(
		`Marked ${count} existing reform summaries as notified (no emails sent).`,
	);
	db.close();
	process.exit(0);
}

// ── Types ───────────────────────────────────────────────────────────────

interface ReformItem {
	id: string;
	title: string;
	rank: string;
	status: string;
	date: string;
	source_id: string;
	headline: string | null;
	summary: string | null;
	reform_type: string | null;
	importance: string | null;
}

// ── Query un-notified reforms ───────────────────────────────────────────

const pending = dbService.getUnnotifiedReforms();

if (pending.length === 0) {
	console.log("No un-notified reforms. Nothing to send.");
	db.close();
	process.exit(0);
}

console.log(`Found ${pending.length} un-notified reforms with summaries.`);

// Set of pending reform keys for filtering query results
const pendingKeys = new Set(
	pending.map((p) => `${p.norm_id}::${p.reform_date}`),
);

// Materias for pending norms (used in intro line)
const pendingNormIds = [...new Set(pending.map((p) => p.norm_id))];
const materiasMap = dbService.getMateriasByNormIds(pendingNormIds);

// ── Display helpers ─────────────────────────────────────────────────────

const MONTHS = [
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

const TYPE_LABELS: Record<string, string> = {
	modification: "Modificación",
	modificacion: "Modificación",
	derogation: "Derogación",
	derogacion: "Derogación",
	correction: "Corrección",
	correccion: "Corrección",
	new_law: "Ley nueva",
	nueva: "Ley nueva",
};

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function reformUrl(r: ReformItem): string {
	return `${SITE_URL}/reforma?id=${encodeURIComponent(r.id)}&date=${encodeURIComponent(r.date)}`;
}

// ── Subscriber matching ─────────────────────────────────────────────────

function getMatchingReforms(
	materias: string[],
	jurisdiction: string,
): ReformItem[] {
	// Query by materia+jurisdiction, then filter to only pending (un-notified) reforms
	const all = dbService.getRecentReformsByMaterias(
		materias,
		jurisdiction,
		"1900-01-01",
	);

	const matches = all.filter(
		(r) => pendingKeys.has(`${r.id}::${r.date}`) && r.headline && r.summary,
	);

	// Deduplicate by headline
	const seen = new Set<string>();
	const deduped: ReformItem[] = [];
	for (const r of matches) {
		const key = r.headline ?? r.title;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(r);
	}

	return deduped.slice(0, MAX_REFORMS_PER_EMAIL);
}

// ── Intro line ──────────────────────────────────────────────────────────

function buildIntroLine(
	reforms: ReformItem[],
	contactMaterias: string[],
): string {
	const materiaCounts = new Map<string, number>();
	for (const r of reforms) {
		const normMaterias = materiasMap.get(r.id) ?? [];
		for (const m of normMaterias) {
			if (contactMaterias.includes(m)) {
				materiaCounts.set(m, (materiaCounts.get(m) ?? 0) + 1);
			}
		}
	}

	const total = reforms.length;
	const cambios =
		total === 1 ? "1 cambio legislativo" : `${total} cambios legislativos`;

	const topMaterias = [...materiaCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3);

	if (topMaterias.length === 0) {
		return `Hay ${cambios} recientes que pueden afectarte.`;
	}
	if (topMaterias.length === 1) {
		return `Hay ${cambios} en ${topMaterias[0]![0]}.`;
	}

	const last = topMaterias.pop()!;
	const rest = topMaterias.map((m) => m[0]).join(", ");
	return `Hay ${cambios} en tus temas: ${rest} y ${last[0]}.`;
}

// ── Email HTML templates ────────────────────────────────────────────────

function buildReformCard(r: ReformItem): string {
	const isHigh = r.importance === "high";
	const borderColor = isHigh ? "#1a365d" : "#d1d5db";
	const typeLabel = TYPE_LABELS[r.reform_type?.toLowerCase() ?? ""] ?? "";
	const typePart = typeLabel ? ` &middot; ${escapeHtml(typeLabel)}` : "";
	const importanceBadge = isHigh
		? ' &nbsp;<span style="display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;background:#eef2f7;color:#1a365d;">Cambio importante</span>'
		: "";

	return `<tr><td style="padding:8px 0;">
<div style="border-left:3px solid ${borderColor};padding:12px 16px;">
  <p style="margin:0 0 4px;font-size:13px;color:#576b80;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(formatDate(r.date))}${typePart}${importanceBadge}</p>
  <p style="margin:4px 0;font-size:18px;font-weight:700;color:#0b1120;line-height:1.35;font-family:Georgia,'Times New Roman',Times,serif;">${escapeHtml(r.headline || r.title)}</p>
  <p style="margin:4px 0 0;font-size:15px;color:#4a6078;line-height:1.55;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
  <p style="margin:8px 0 0;"><a href="${reformUrl(r)}" style="font-size:13px;color:#2b5797;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">Ver qu\u00E9 cambi\u00F3 &#8594;</a></p>
</div>
</td></tr>`;
}

function buildFooter(unsubUrl: string): string {
	const prefsUrl = `${SITE_URL}/mi-situacion`;
	return `<tr><td style="padding:0 28px 24px;">
  <hr style="border:none;border-top:1px solid #e8ecf0;margin:0 0 16px;">
  <p style="margin:0 0 6px;font-size:12px;color:#6b8299;line-height:1.6;font-family:Arial,Helvetica,sans-serif;">
    Recibes esto porque te suscribiste a alertas legislativas en Ley Abierta.
    <a href="${prefsUrl}" style="color:#2b5797;">Cambiar preferencias</a> &middot;
    <a href="${unsubUrl}" style="color:#2b5797;">Cancelar suscripci\u00F3n</a>
  </p>
  <p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,Helvetica,sans-serif;">Fuente: Agencia Estatal BOE &middot; <a href="${SITE_URL}" style="color:#9ca3af;">leyabierta.es</a></p>
</td></tr>`;
}

function buildSingleReformHtml(r: ReformItem, unsubUrl: string): string {
	const isHigh = r.importance === "high";
	const typeLabel = TYPE_LABELS[r.reform_type?.toLowerCase() ?? ""] ?? "";
	const typePart = typeLabel ? ` &middot; ${escapeHtml(typeLabel)}` : "";
	const importanceBadge = isHigh
		? ' <span style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;background:#eef2f7;color:#1a365d;margin-left:8px;">Cambio importante</span>'
		: "";

	return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(r.headline || r.title)}</title></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
<center>
<div style="max-width:600px;margin:0 auto;padding:24px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px;">
    <tr><td style="padding:28px 28px 0;">
      <p style="margin:0 0 16px;font-size:13px;color:#576b80;">${escapeHtml(formatDate(r.date))}${typePart} ${importanceBadge}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0b1120;line-height:1.3;font-family:Georgia,'Times New Roman',Times,serif;">${escapeHtml(r.headline || r.title)}</h1>
      <p style="margin:0 0 24px;font-size:16px;color:#4a6078;line-height:1.6;">${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
      <p style="margin:0 0 28px;">
        <a href="${reformUrl(r)}" style="display:inline-block;padding:12px 28px;background:#1a365d;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Ver qu\u00E9 cambi\u00F3 &#8594;</a>
      </p>
    </td></tr>
    ${buildFooter(unsubUrl)}
  </table>
</div>
</center>
</body>
</html>`;
}

function buildMultiReformHtml(
	reforms: ReformItem[],
	introLine: string,
	unsubUrl: string,
	overflowCount: number,
): string {
	const cards = reforms.map(buildReformCard).join("\n");
	const overflow =
		overflowCount > 0
			? `<tr><td style="padding:4px 0 12px;font-size:13px;color:#576b80;font-family:Arial,Helvetica,sans-serif;">y ${overflowCount} m\u00E1s en <a href="${SITE_URL}/mis-cambios" style="color:#2b5797;">leyabierta.es/mis-cambios</a></td></tr>`
			: "";

	return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Tus cambios legislativos</title></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
<center>
<div style="max-width:600px;margin:0 auto;padding:24px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px 8px 0 0;">
    <tr><td style="padding:28px 28px 0;">
      <h1 style="margin:0;font-size:24px;font-weight:700;color:#0b1120;line-height:1.2;font-family:Georgia,'Times New Roman',Times,serif;">Tus cambios legislativos</h1>
    </td></tr>
    <tr><td style="padding:12px 28px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f9fa;border-radius:6px;border-left:3px solid #1a365d;">
        <tr><td style="padding:12px 16px;font-size:15px;color:#4a6078;line-height:1.5;">
          ${escapeHtml(introLine)}
        </td></tr>
      </table>
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr><td style="padding:0 28px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${cards}
        ${overflow}
      </table>
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr><td style="padding:24px 28px;text-align:center;">
      <a href="${SITE_URL}/mis-cambios" style="display:inline-block;padding:12px 28px;background:#1a365d;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Ver todos tus cambios</a>
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:0 0 8px 8px;">
    ${buildFooter(unsubUrl)}
  </table>
</div>
</center>
</body>
</html>`;
}

// ── Preview mode ────────────────────────────────────────────────────────

if (previewMode) {
	const previewMateriasRaw = getArg("materias");
	const previewJurisdiction = getArg("jurisdiction") ?? "es";

	if (!previewMateriasRaw) {
		console.error(
			"Preview requires --materias. Example:\n  --materias 'Impuesto sobre la Renta de las Personas Físicas,Seguridad Social' --jurisdiction es-vc",
		);
		db.close();
		process.exit(1);
	}

	const previewMaterias = previewMateriasRaw.startsWith("[")
		? (JSON.parse(previewMateriasRaw) as string[])
		: previewMateriasRaw.split(",").map((s) => s.trim());

	console.log(
		`Preview: ${previewMaterias.length} materias, jurisdiction=${previewJurisdiction}`,
	);

	const reforms = getMatchingReforms(previewMaterias, previewJurisdiction);
	if (reforms.length === 0) {
		console.log("No un-notified reforms match. Nothing to preview.");
		db.close();
		process.exit(0);
	}

	console.log(`${reforms.length} reforms match.`);

	const unsubUrl = `${SITE_URL}/alertas/cancelar?email=preview&code=preview`;

	if (reforms.length === 1) {
		console.log(buildSingleReformHtml(reforms[0]!, unsubUrl));
	} else {
		const intro = buildIntroLine(reforms, previewMaterias);
		console.log(buildMultiReformHtml(reforms, intro, unsubUrl, 0));
	}

	db.close();
	process.exit(0);
}

// ── Send mode ───────────────────────────────────────────────────────────

if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID) {
	console.error("RESEND_API_KEY and RESEND_AUDIENCE_ID must be set.");
	db.close();
	process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

interface ResendContact {
	id: string;
	email: string;
	unsubscribed: boolean;
	properties?: Record<string, string>;
}

let contacts: ResendContact[] = [];
try {
	const response = await resend.contacts.list({
		audienceId: RESEND_AUDIENCE_ID,
	});
	contacts = (response.data?.data ?? []).filter(
		(c: ResendContact) => !c.unsubscribed,
	);
} catch (err) {
	console.error("Failed to fetch contacts from Resend:", err);
	db.close();
	process.exit(1);
}

console.log(`Found ${contacts.length} subscribed contacts.`);

interface ContactInfo {
	email: string;
	materias: string[];
	jurisdiction: string;
}

const contactInfos: ContactInfo[] = [];
let legacySkipped = 0;

for (const c of contacts) {
	const props = c.properties ?? {};
	let materias: string[] = [];
	try {
		materias = JSON.parse(props.materias ?? "[]");
	} catch {
		// ignore
	}
	if (materias.length === 0) {
		legacySkipped++;
		continue;
	}
	contactInfos.push({
		email: c.email,
		materias,
		jurisdiction: props.jurisdiction ?? "es",
	});
}

if (legacySkipped > 0) {
	console.log(`Skipped ${legacySkipped} legacy contacts without materias.`);
}
console.log(`Processing ${contactInfos.length} contacts with materias.`);

// ── Send per subscriber ─────────────────────────────────────────────────

const reformCache = new Map<string, ReformItem[]>();

function getCacheKey(materias: string[], jurisdiction: string): string {
	return `${jurisdiction}::${[...materias].sort().join("|")}`;
}

let sent = 0;
let skipped = 0;

for (const contact of contactInfos) {
	const cacheKey = getCacheKey(contact.materias, contact.jurisdiction);
	let reforms = reformCache.get(cacheKey);
	if (!reforms) {
		reforms = getMatchingReforms(contact.materias, contact.jurisdiction);
		reformCache.set(cacheKey, reforms);
	}

	if (reforms.length === 0) {
		skipped++;
		continue;
	}

	const unsubUrl = await buildUnsubscribeUrl(contact.email);

	let html: string;
	let subject: string;

	if (reforms.length === 1) {
		const r = reforms[0]!;
		subject = `Ley Abierta — ${r.headline || "Cambio legislativo que te afecta"}`;
		html = buildSingleReformHtml(r, unsubUrl);
	} else {
		subject = `Ley Abierta — ${reforms.length} cambios legislativos que te afectan`;
		const introLine = buildIntroLine(reforms, contact.materias);
		html = buildMultiReformHtml(reforms, introLine, unsubUrl, 0);
	}

	if (dryRun) {
		console.log(
			`[dry-run] ${contact.email}: ${reforms.length} reforms, subject: "${subject}"`,
		);
		sent++;
		continue;
	}

	const ok = await sendNotificationEmail(contact.email, subject, html);
	if (ok) sent++;
	else console.error(`Failed: ${contact.email}`);
}

// Mark all pending reforms as notified AFTER sends complete
if (!dryRun) {
	dbService.markReformsNotified(pending);
	console.log(`Marked ${pending.length} reforms as notified.`);
}

console.log(`Done. Sent: ${sent}, Skipped: ${skipped}`);
db.close();
