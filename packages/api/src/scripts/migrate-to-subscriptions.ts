/**
 * One-shot migration: backfill the unified `subscriptions` table from the two
 * legacy stores it replaces — Resend Audiences (materias + jurisdiccion) and
 * the local `norm_follows` table.
 *
 * Idempotent. Re-running is safe: upsertSubscription preserves prior
 * `confirmed=1` state and rewrites tokens deterministically.
 *
 * Usage:
 *   bun run packages/api/src/scripts/migrate-to-subscriptions.ts
 *   bun run packages/api/src/scripts/migrate-to-subscriptions.ts --dry-run
 *
 * Run once on production after deploying the schema migration. Subsequent
 * runs are no-ops unless new rows exist in either source.
 */

import { Database } from "bun:sqlite";
import { createSchema } from "@leyabierta/pipeline";
import { Resend } from "resend";
import { DbService } from "../services/db.ts";
import { generateHmac } from "../services/email.ts";

const DB_PATH = process.env.DB_PATH ?? "./data/leyabierta.db";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID ?? "";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID) {
	console.error("RESEND_API_KEY and RESEND_AUDIENCE_ID must be set. Aborting.");
	process.exit(1);
}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
createSchema(db);
const dbService = new DbService(db);

interface ResendContact {
	id: string;
	email: string;
	unsubscribed: boolean;
	properties?: Record<string, string>;
}

async function unsubTokenForEmail(email: string): Promise<string> {
	return generateHmac(`${email}:unsub`);
}

async function migrateResendContacts(): Promise<{
	contacts: number;
	rows: number;
}> {
	const resend = new Resend(RESEND_API_KEY);
	let contacts: ResendContact[] = [];
	try {
		const response = await resend.contacts.list({
			audienceId: RESEND_AUDIENCE_ID,
		});
		contacts = response.data?.data ?? [];
	} catch (err) {
		console.error("Failed to fetch contacts from Resend:", err);
		return { contacts: 0, rows: 0 };
	}

	let rowsWritten = 0;
	for (const c of contacts) {
		const props = c.properties ?? {};
		let materias: string[] = [];
		try {
			materias = JSON.parse(props.materias ?? "[]");
		} catch {
			// no materias on this contact
		}
		const jurisdiction = props.jurisdiction ?? "es";

		// confirmed=1 only when Resend says the contact is subscribed
		// (unsubscribed=false). Pending double-opt-in contacts stay confirmed=0.
		const confirmed = !c.unsubscribed;
		const confirmToken = await generateHmac(c.email);
		const unsubToken = await unsubTokenForEmail(c.email);

		const items: Array<{ type: "materia" | "jurisdiccion"; scope: string }> = [
			...materias.map((m: string) => ({
				type: "materia" as const,
				scope: m,
			})),
			{ type: "jurisdiccion" as const, scope: jurisdiction },
		];

		if (dryRun) {
			console.log(
				`[dry] ${c.email} → ${items.length} rows (confirmed=${confirmed})`,
			);
			rowsWritten += items.length;
			continue;
		}

		for (const item of items) {
			dbService.upsertSubscription({
				email: c.email,
				type: item.type,
				scope: item.scope,
				confirmToken,
				unsubToken,
				confirmed,
			});
			rowsWritten++;
		}
	}

	return { contacts: contacts.length, rows: rowsWritten };
}

async function migrateNormFollows(): Promise<{
	rows: number;
}> {
	const rows = db
		.query<
			{ email: string; norm_id: string; confirmed: number; token: string },
			[]
		>(`SELECT email, norm_id, confirmed, token FROM norm_follows`)
		.all();

	let written = 0;
	for (const r of rows) {
		const unsubToken = await unsubTokenForEmail(r.email);
		const confirmed = r.confirmed === 1;

		if (dryRun) {
			console.log(
				`[dry] follow ${r.email} → ${r.norm_id} (confirmed=${confirmed})`,
			);
			written++;
			continue;
		}

		dbService.upsertSubscription({
			email: r.email,
			type: "norma",
			scope: r.norm_id,
			confirmToken: r.token,
			unsubToken,
			confirmed,
		});
		written++;
	}

	return { rows: written };
}

console.log(
	`Migrating to unified subscriptions table${dryRun ? " (dry run)" : ""}…`,
);

const resendResult = await migrateResendContacts();
console.log(
	`Resend Audiences: ${resendResult.contacts} contacts → ${resendResult.rows} subscription rows`,
);

const followsResult = await migrateNormFollows();
console.log(`norm_follows: ${followsResult.rows} subscription rows`);

const total = resendResult.rows + followsResult.rows;
console.log(`Total rows ${dryRun ? "would be " : ""}written: ${total}`);

if (!dryRun) {
	const after = db
		.query<{ c: number }, []>(
			"SELECT COUNT(*) AS c FROM subscriptions WHERE confirmed = 1",
		)
		.get();
	console.log(`Confirmed rows in subscriptions now: ${after?.c ?? 0}`);
}

db.close();
