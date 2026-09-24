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
import { DbService } from "../services/db.ts";
import {
	buildUnsubscribeUrl,
	maskEmail,
	sendNotificationEmail,
} from "../services/email.ts";
import {
	buildMultiReformHtml,
	buildSingleReformHtml,
} from "../services/reform-email.ts";

// ── Config ──────────────────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const SITE_URL = process.env.SITE_URL ?? "https://leyabierta.es";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
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

// ── Subscriber matching ─────────────────────────────────────────────────

function getMatchingReforms(
	materias: string[],
	jurisdictions: string[],
): ReformItem[] {
	// Query by materia+jurisdiction (one call per jurisdiction the user follows),
	// then filter to only pending (un-notified) reforms.
	const all = jurisdictions.flatMap((j) =>
		dbService.getRecentReformsByMaterias(materias, j, "1900-01-01"),
	);

	const matches = all.filter(
		(r) => pendingKeys.has(`${r.id}::${r.date}`) && r.headline && r.summary,
	);

	// Deduplicate by (id, date) first (multiple jurisdictions may surface the
	// same reform), then by headline.
	const idSeen = new Set<string>();
	const seen = new Set<string>();
	const deduped: ReformItem[] = [];
	for (const r of matches) {
		const idKey = `${r.id}::${r.date}`;
		if (idSeen.has(idKey)) continue;
		idSeen.add(idKey);
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

	const reforms = getMatchingReforms(previewMaterias, [previewJurisdiction]);
	if (reforms.length === 0) {
		console.log("No un-notified reforms match. Nothing to preview.");
		db.close();
		process.exit(0);
	}

	console.log(`${reforms.length} reforms match.`);

	const unsubUrl = `${SITE_URL}/alertas/cancelar?email=preview&code=preview`;

	if (reforms.length === 1) {
		console.log(buildSingleReformHtml(SITE_URL, reforms[0]!, unsubUrl));
	} else {
		const intro = buildIntroLine(reforms, previewMaterias);
		console.log(buildMultiReformHtml(SITE_URL, reforms, intro, unsubUrl, 0));
	}

	db.close();
	process.exit(0);
}

// ── Send mode ───────────────────────────────────────────────────────────

if (!RESEND_API_KEY) {
	console.error("RESEND_API_KEY must be set.");
	db.close();
	process.exit(1);
}

// Source of truth: unified `subscriptions` table. Resend Audiences is no
// longer read here. The migration script (migrate-to-subscriptions.ts)
// backfills from Resend + norm_follows; from this point onward `subscriptions`
// is what determines who gets what.

interface ContactInfo {
	email: string;
	materias: string[];
	jurisdictions: string[];
	followedNormIds: string[];
}

const allSubs = dbService.getAllConfirmedSubscriptions();
console.log(`Found ${allSubs.length} confirmed subscription rows.`);

const byEmail = new Map<string, ContactInfo>();
for (const s of allSubs) {
	const info = byEmail.get(s.email) ?? {
		email: s.email,
		materias: [],
		jurisdictions: [],
		followedNormIds: [],
	};
	if (s.type === "materia") info.materias.push(s.scope);
	else if (s.type === "jurisdiccion") info.jurisdictions.push(s.scope);
	else if (s.type === "norma") info.followedNormIds.push(s.scope);
	byEmail.set(s.email, info);
}

// Default to state-level ("es") when a recipient hasn't picked any jurisdiction.
for (const info of byEmail.values()) {
	if (info.jurisdictions.length === 0) info.jurisdictions.push("es");
}

const contactInfos = [...byEmail.values()].filter(
	(c) => c.materias.length > 0 || c.followedNormIds.length > 0,
);

console.log(`Processing ${contactInfos.length} unique recipients.`);

// ── Reform lookup helpers ───────────────────────────────────────────────

// Build reformByKey directly from `pending`, which already carries
// headline/summary/reform_type/importance from getUnnotifiedReforms.
// Fetching by jurisdiction would silently drop autonomic-community laws,
// and per-row CTE queries are wasteful when we have the data in hand.
const reformByKey = new Map<string, ReformItem>(
	pending
		.map((p): [string, ReformItem | undefined] => {
			const norm = dbService.getLaw(p.norm_id);
			if (!norm) return [`${p.norm_id}::${p.reform_date}`, undefined];
			return [
				`${p.norm_id}::${p.reform_date}`,
				{
					id: p.norm_id,
					title: norm.title,
					rank: norm.rank,
					status: norm.status,
					date: p.reform_date,
					source_id: p.source_id,
					headline: p.headline,
					summary: p.summary,
					reform_type: p.reform_type,
					importance: p.importance,
				},
			];
		})
		.filter((entry): entry is [string, ReformItem] => entry[1] != null),
);

function getReformsByNormIds(normIds: string[]): ReformItem[] {
	const result: ReformItem[] = [];
	for (const id of normIds) {
		for (const p of pending) {
			if (p.norm_id !== id) continue;
			const r = reformByKey.get(`${p.norm_id}::${p.reform_date}`);
			if (r?.headline && r?.summary) result.push(r);
		}
	}
	return result;
}

// ── Send per subscriber ─────────────────────────────────────────────────

const materiaCache = new Map<string, ReformItem[]>();

function getCacheKey(materias: string[], jurisdictions: string[]): string {
	return `${[...jurisdictions].sort().join(",")}::${[...materias].sort().join("|")}`;
}

let sent = 0;
let skipped = 0;

for (const contact of contactInfos) {
	// Materias + jurisdiccion matches (cached across recipients).
	let materiaMatches: ReformItem[] = [];
	if (contact.materias.length > 0) {
		const cacheKey = getCacheKey(contact.materias, contact.jurisdictions);
		const cached = materiaCache.get(cacheKey);
		if (cached) {
			materiaMatches = cached;
		} else {
			materiaMatches = getMatchingReforms(
				contact.materias,
				contact.jurisdictions,
			);
			materiaCache.set(cacheKey, materiaMatches);
		}
	}

	// Followed-law matches (always per-recipient — typically a small set).
	const followMatches = getReformsByNormIds(contact.followedNormIds);

	// Merge and deduplicate by (id, date). Followed laws first: an explicit
	// follow is a stronger signal than a materia match, so when MAX_REFORMS_PER_EMAIL
	// caps the list we keep the user-curated picks ahead of broad-topic hits.
	const seen = new Set<string>();
	const merged: ReformItem[] = [];
	for (const r of [...followMatches, ...materiaMatches]) {
		const k = `${r.id}::${r.date}`;
		if (seen.has(k)) continue;
		seen.add(k);
		merged.push(r);
	}
	const reforms = merged.slice(0, MAX_REFORMS_PER_EMAIL);

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
		html = buildSingleReformHtml(SITE_URL, r, unsubUrl);
	} else {
		subject = `Ley Abierta — ${reforms.length} cambios legislativos que te afectan`;
		const introLine = buildIntroLine(reforms, contact.materias);
		html = buildMultiReformHtml(SITE_URL, reforms, introLine, unsubUrl, 0);
	}

	if (dryRun) {
		console.log(
			`[dry-run] ${maskEmail(contact.email)}: ${reforms.length} reforms (${materiaMatches.length} by materia, ${followMatches.length} by follow), subject: "${subject}"`,
		);
		sent++;
		continue;
	}

	const ok = await sendNotificationEmail(contact.email, subject, html);
	if (ok) sent++;
	else console.error(`Failed: ${maskEmail(contact.email)}`);
}

// Mark all pending reforms as notified AFTER sends complete
if (!dryRun) {
	dbService.markReformsNotified(pending);
	console.log(`Marked ${pending.length} reforms as notified.`);
}

console.log(`Done. Sent: ${sent}, Skipped: ${skipped}`);
db.close();
