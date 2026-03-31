/**
 * Weekly digest sender — run with: bun run packages/api/src/scripts/send-digest.ts
 *
 * Queries reforms from the past 7 days, matches against subscriber profiles,
 * and sends digest emails via Resend.
 *
 * Flags:
 *   --preview   Print digest HTML to stdout instead of sending emails
 *   --dry-run   Log what would be sent without actually sending
 *   --days N    Override the lookback window (default: 7)
 */

import { Database } from "bun:sqlite";
import { createSchema } from "@leyabierta/pipeline";
import { getProfileById, PROFILES } from "../data/profiles.ts";
import { DbService } from "../services/db.ts";
import {
	buildDigestHtml,
	type DigestItem,
	sendDigestEmail,
} from "../services/email.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";

const args = process.argv.slice(2);
const preview = args.includes("--preview");
const dryRun = args.includes("--dry-run");
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 7;

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);

const dbService = new DbService(db);

const since = new Date();
since.setDate(since.getDate() - days);
const sinceStr = since.toISOString().slice(0, 10);

const RANK_LABELS: Record<string, string> = {
	constitucion: "Constitucion",
	ley_organica: "Ley Organica",
	ley: "Ley",
	real_decreto_ley: "Real Decreto-ley",
	real_decreto_legislativo: "RD Legislativo",
	real_decreto: "Real Decreto",
	orden: "Orden",
	instruccion: "Instruccion",
	circular: "Circular",
	decreto: "Decreto",
	acuerdo_internacional: "Acuerdo Int.",
};

const JURISDICTION_LABELS: Record<string, string> = {
	es: "Estatal",
	"es-an": "Andalucia",
	"es-ar": "Aragon",
	"es-as": "Asturias",
	"es-cb": "Cantabria",
	"es-cl": "Castilla y Leon",
	"es-cm": "Castilla-La Mancha",
	"es-cn": "Canarias",
	"es-ct": "Cataluna",
	"es-ex": "Extremadura",
	"es-ga": "Galicia",
	"es-ib": "Illes Balears",
	"es-mc": "Murcia",
	"es-md": "Madrid",
	"es-nc": "Navarra",
	"es-pv": "Pais Vasco",
	"es-ri": "La Rioja",
	"es-vc": "C. Valenciana",
};

if (preview) {
	// Preview mode: show digest for each profile
	for (const profile of PROFILES) {
		const reforms = dbService.getRecentReformsByMaterias(
			profile.materias,
			"es",
			sinceStr,
		);
		console.log(
			`\n=== ${profile.name} (${reforms.length} reforms since ${sinceStr}) ===`,
		);

		if (reforms.length === 0) {
			console.log("No reforms found for this profile.");
			continue;
		}

		const items: DigestItem[] = reforms.map((r) => ({
			id: r.id,
			title: r.title,
			rank: RANK_LABELS[r.rank] ?? r.rank,
			date: r.date,
		}));

		const html = buildDigestHtml(
			profile.name,
			"Estatal",
			items,
			"preview-token",
		);
		console.log(html);
	}
	process.exit(0);
}

// Send mode
const subscribers = dbService.getConfirmedSubscribers();
console.log(`Found ${subscribers.length} confirmed subscribers.`);
console.log(`Looking back ${days} days (since ${sinceStr}).`);

// Group by profile + jurisdiction to avoid redundant queries
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

	const reforms = dbService.getRecentReformsByMaterias(
		profile.materias,
		jurisdiction!,
		sinceStr,
	);

	if (reforms.length === 0) {
		skipped += subs.length;
		continue;
	}

	const items: DigestItem[] = reforms.map((r) => ({
		id: r.id,
		title: r.title,
		rank: RANK_LABELS[r.rank] ?? r.rank,
		date: r.date,
	}));

	const jurisdictionLabel = JURISDICTION_LABELS[jurisdiction!] ?? jurisdiction!;

	for (const sub of subs) {
		const html = buildDigestHtml(
			profile.name,
			jurisdictionLabel,
			items,
			sub.token,
		);

		if (dryRun) {
			console.log(
				`[dry-run] Would send to ${sub.email}: ${profile.name} (${jurisdictionLabel}), ${items.length} items`,
			);
			sent++;
			continue;
		}

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

console.log(`Done. Sent: ${sent}, Skipped (no reforms): ${skipped}`);
db.close();
