/**
 * Remove every trace of the email alerts (decision of 2026-09-24: no accounts,
 * no emails). Why this exists: the code that collected and used these emails is
 * gone, so the data has no purpose left and the GDPR says it must go (art. 5.1.b/e).
 *
 * What it does:
 *   1. SQLite: drops the email tables (subscriptions, subscribers, norm_follows,
 *      notification_runs, notified_reforms) — their rows are emails, tokens and
 *      send bookkeeping, nothing else uses them.
 *   2. Resend: deletes every contact of every audience, then the audiences, and
 *      any contact in the global contacts list.
 *
 * NO backup is taken on purpose: keeping a copy would defeat the deletion. The
 * daily generated-content backups (#204) held these tables until this change;
 * they rotate out within 14 days (see docs/RAT.md).
 *
 * Dry run by default: prints counts and masked emails (a***@dominio). --apply
 * deletes. The Resend key is read from RESEND_API_KEY and never printed. If the
 * key is missing, --apply refuses unless --skip-resend is passed.
 *
 * HOW TO RUN IN PRODUCTION — `scripts/` is not in the Docker image; copy it in
 * and exec it, dry run first, never while another `docker exec` writes:
 *
 *   docker cp scripts/ad-hoc/remove-email-data.ts code-api-1:/tmp/
 *   docker exec code-api-1 bun run /tmp/remove-email-data.ts /data/leyabierta.db
 *   docker exec code-api-1 bun run /tmp/remove-email-data.ts /data/leyabierta.db --apply
 *   docker exec -u root code-api-1 rm -f /tmp/remove-email-data.ts
 */
import { Database } from "bun:sqlite";

export const EMAIL_TABLES = [
	"subscriptions",
	"subscribers",
	"norm_follows",
	"notification_runs",
	"notified_reforms",
] as const;

const RESEND_API = "https://api.resend.com";

export function maskEmail(email: string): string {
	const [user = "", domain = ""] = email.split("@");
	return `${user.slice(0, 1)}***@${domain}`;
}

export function emailTableCounts(db: Database): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const table of EMAIL_TABLES) {
		const exists = db
			.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(table);
		if (!exists) continue;
		counts[table] = (
			db.query(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }
		).n;
	}
	return counts;
}

export function dropEmailTables(db: Database): string[] {
	const dropped: string[] = [];
	db.transaction(() => {
		for (const table of Object.keys(emailTableCounts(db))) {
			db.run(`DROP TABLE "${table}"`);
			dropped.push(table);
		}
	}).immediate();
	return dropped;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface ResendContact {
	id: string;
	email: string;
}

export interface ResendPlan {
	audiences: { id: string; name: string; contacts: ResendContact[] }[];
	globalContacts: ResendContact[];
}

async function getJson(
	fetchFn: Fetch,
	key: string,
	path: string,
): Promise<{ status: number; data: unknown }> {
	const res = await fetchFn(`${RESEND_API}${path}`, {
		headers: { Authorization: `Bearer ${key}` },
	});
	const body = (await res.json().catch(() => null)) as {
		data?: unknown;
	} | null;
	return { status: res.status, data: body?.data ?? [] };
}

export async function planResend(
	fetchFn: Fetch,
	key: string,
): Promise<ResendPlan> {
	const plan: ResendPlan = { audiences: [], globalContacts: [] };
	const audiences = await getJson(fetchFn, key, "/audiences");
	if (audiences.status >= 400 && audiences.status !== 404) {
		throw new Error(`Resend GET /audiences → HTTP ${audiences.status}`);
	}
	for (const a of audiences.data as { id: string; name: string }[]) {
		const contacts = await getJson(
			fetchFn,
			key,
			`/audiences/${encodeURIComponent(a.id)}/contacts`,
		);
		if (contacts.status >= 400) {
			throw new Error(
				`Resend GET contacts of audience ${a.id} → HTTP ${contacts.status}`,
			);
		}
		plan.audiences.push({
			id: a.id,
			name: a.name,
			contacts: contacts.data as ResendContact[],
		});
	}
	if (audiences.status === 404) {
		console.warn(
			"Resend GET /audiences → HTTP 404: no audiences API on this account",
		);
	}
	// Newer accounts keep contacts outside audiences.
	const global = await getJson(fetchFn, key, "/contacts");
	if (global.status < 400) plan.globalContacts = global.data as ResendContact[];
	else
		console.warn(
			`Resend GET /contacts → HTTP ${global.status}: global contacts not listed (check the dashboard by hand)`,
		);
	return plan;
}

/** Resend allows ~2 requests/s per account: pause between deletions. */
const PAUSE_MS = 300;
const MAX_RETRIES = 4;

export async function applyResend(
	fetchFn: Fetch,
	key: string,
	plan: ResendPlan,
	sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<{ deleted: number; failed: string[] }> {
	const failed: string[] = [];
	let deleted = 0;
	const del = async (path: string) => {
		for (let attempt = 0; ; attempt++) {
			const res = await fetchFn(`${RESEND_API}${path}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${key}` },
			});
			if (res.status === 429 && attempt < MAX_RETRIES) {
				// Honour Retry-After (seconds); otherwise back off 1 s, 2 s, 4 s…
				const retryAfter = Number(res.headers.get("retry-after"));
				await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
				continue;
			}
			// 404 = already gone: the goal is reached.
			if (res.ok || res.status === 404) deleted++;
			else failed.push(`${path} → HTTP ${res.status}`);
			await sleep(PAUSE_MS);
			return;
		}
	};
	for (const a of plan.audiences) {
		const audience = encodeURIComponent(a.id);
		for (const c of a.contacts) {
			await del(`/audiences/${audience}/contacts/${encodeURIComponent(c.id)}`);
		}
		await del(`/audiences/${audience}`);
	}
	for (const c of plan.globalContacts) {
		await del(`/contacts/${encodeURIComponent(c.id)}`);
	}
	return { deleted, failed };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const dbPath = args.find((a) => !a.startsWith("--"));
	const apply = args.includes("--apply");
	const skipResend = args.includes("--skip-resend");
	if (!dbPath) {
		console.error(
			"Usage: remove-email-data.ts <leyabierta.db> [--apply] [--skip-resend]",
		);
		process.exit(2);
	}
	const key = process.env.RESEND_API_KEY ?? "";
	if (apply && !key && !skipResend) {
		console.error(
			"RESEND_API_KEY is not set: pass --skip-resend to drop only the SQLite tables.",
		);
		process.exit(1);
	}

	const db = apply
		? new Database(dbPath, { readwrite: true, create: false })
		: new Database(dbPath, { readonly: true });
	console.log(apply ? "== APPLY ==" : "== DRY RUN (nothing is deleted) ==");
	console.log("SQLite email tables:", emailTableCounts(db));

	let plan: ResendPlan | null = null;
	if (key && !skipResend) {
		plan = await planResend(fetch, key);
		for (const a of plan.audiences) {
			console.log(
				`Resend audience "${a.name}" (${a.id}): ${a.contacts.length} contacts`,
				a.contacts.map((c) => maskEmail(c.email)),
			);
		}
		console.log(
			`Resend global contacts: ${plan.globalContacts.length}`,
			plan.globalContacts.map((c) => maskEmail(c.email)),
		);
	} else {
		console.log("Resend: skipped (no RESEND_API_KEY or --skip-resend)");
	}

	if (!apply) process.exit(0);

	if (plan) {
		const { deleted, failed } = await applyResend(fetch, key, plan);
		console.log(`Resend: ${deleted} objects deleted`);
		if (failed.length > 0) {
			console.error("Resend deletions failed (SQLite left untouched):", failed);
			process.exit(1);
		}
	}
	console.log("SQLite tables dropped:", dropEmailTables(db));
	db.close();
}
