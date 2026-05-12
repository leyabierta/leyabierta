/**
 * Tests for the unified subscriptions table and DbService methods.
 *
 * Covers the core invariants:
 * - upsertSubscription is idempotent and preserves prior confirmed=1 state
 * - confirmSubscriptionsByToken flips all rows sharing a token
 * - getAllConfirmedSubscriptions returns only confirmed rows
 * - delete by id+token is gated by token (cookie-equivalent)
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSchema } from "@leyabierta/pipeline";
import { DbService } from "../services/db.ts";

let db: Database;
let svc: DbService;

beforeEach(() => {
	db = new Database(":memory:");
	createSchema(db);
	svc = new DbService(db);
});

afterEach(() => {
	db.close();
});

describe("subscriptions table", () => {
	it("upserts a new row and reads it back", () => {
		svc.upsertSubscription({
			email: "alice@example.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: "ctok-1",
			unsubToken: "utok-1",
			confirmed: false,
		});

		const rows = svc.getSubscriptionsByEmail("alice@example.com");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.type).toBe("materia");
		expect(rows[0]?.scope).toBe("IRPF");
		expect(rows[0]?.confirmed).toBe(0);
	});

	it("upsert is idempotent on (email, type, scope)", () => {
		const args = {
			email: "alice@example.com",
			type: "materia" as const,
			scope: "IRPF",
			confirmToken: "ctok-1",
			unsubToken: "utok-1",
			confirmed: false,
		};
		svc.upsertSubscription(args);
		svc.upsertSubscription(args);
		svc.upsertSubscription(args);

		const rows = svc.getSubscriptionsByEmail("alice@example.com");
		expect(rows).toHaveLength(1);
	});

	it("preserves confirmed=1 even when re-upserting with confirmed=false", () => {
		// Initial confirmed insert
		svc.upsertSubscription({
			email: "alice@example.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: "ctok-1",
			unsubToken: "utok-1",
			confirmed: true,
		});
		// Re-upsert with confirmed=false (e.g., user re-subscribed)
		svc.upsertSubscription({
			email: "alice@example.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: "ctok-2",
			unsubToken: "utok-2",
			confirmed: false,
		});

		const rows = svc.getSubscriptionsByEmail("alice@example.com");
		expect(rows[0]?.confirmed).toBe(1);
		// Unsub token is preserved when row was already confirmed
		const byUnsub = svc.getSubscriptionsByUnsubToken("utok-1");
		expect(byUnsub).toHaveLength(1);
	});

	it("confirmSubscriptionsByToken flips all rows sharing the token", () => {
		const ct = "shared-token";
		const ut = "shared-utok";
		svc.upsertSubscription({
			email: "bob@example.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: ct,
			unsubToken: ut,
			confirmed: false,
		});
		svc.upsertSubscription({
			email: "bob@example.com",
			type: "jurisdiccion",
			scope: "es-md",
			confirmToken: ct,
			unsubToken: ut,
			confirmed: false,
		});

		const flipped = svc.confirmSubscriptionsByToken(ct);
		expect(flipped).toBe(2);
		const rows = svc.getSubscriptionsByEmail("bob@example.com");
		expect(rows.every((r) => r.confirmed === 1)).toBe(true);
	});

	it("getAllConfirmedSubscriptions returns only confirmed", () => {
		svc.upsertSubscription({
			email: "a@x.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: "ct1",
			unsubToken: "ut1",
			confirmed: true,
		});
		svc.upsertSubscription({
			email: "b@x.com",
			type: "materia",
			scope: "Empleo",
			confirmToken: "ct2",
			unsubToken: "ut2",
			confirmed: false,
		});

		const all = svc.getAllConfirmedSubscriptions();
		expect(all).toHaveLength(1);
		expect(all[0]?.email).toBe("a@x.com");
	});

	it("getConfirmedEmailsForScope finds matching subscribers", () => {
		svc.upsertSubscription({
			email: "a@x.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: "ct1",
			unsubToken: "ut1",
			confirmed: true,
		});
		svc.upsertSubscription({
			email: "b@x.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: "ct2",
			unsubToken: "ut2",
			confirmed: true,
		});
		svc.upsertSubscription({
			email: "c@x.com",
			type: "materia",
			scope: "Empleo",
			confirmToken: "ct3",
			unsubToken: "ut3",
			confirmed: true,
		});

		const irpfEmails = svc.getConfirmedEmailsForScope("materia", "IRPF");
		expect(irpfEmails.sort()).toEqual(["a@x.com", "b@x.com"]);
	});

	it("deleteSubscription requires matching token (cookie gate)", () => {
		svc.upsertSubscription({
			email: "alice@example.com",
			type: "norma",
			scope: "BOE-A-1978-31229",
			confirmToken: "ctok",
			unsubToken: "right-utok",
			confirmed: true,
		});
		const rowsBefore = svc.getSubscriptionsByEmail("alice@example.com");
		const id = rowsBefore[0]?.id ?? 0;

		// Wrong token: no-op
		expect(svc.deleteSubscription(id, "wrong-utok")).toBe(false);
		expect(svc.getSubscriptionsByEmail("alice@example.com")).toHaveLength(1);

		// Right token: deletes
		expect(svc.deleteSubscription(id, "right-utok")).toBe(true);
		expect(svc.getSubscriptionsByEmail("alice@example.com")).toHaveLength(0);
	});

	it("deleteSubscriptionsByEmail removes all rows for an email", () => {
		for (const scope of ["IRPF", "Empleo", "Vivienda"]) {
			svc.upsertSubscription({
				email: "alice@example.com",
				type: "materia",
				scope,
				confirmToken: `ct-${scope}`,
				unsubToken: "ut",
				confirmed: true,
			});
		}
		expect(svc.getSubscriptionsByEmail("alice@example.com")).toHaveLength(3);
		svc.deleteSubscriptionsByEmail("alice@example.com");
		expect(svc.getSubscriptionsByEmail("alice@example.com")).toHaveLength(0);
	});

	it("getSubscriptionsByUnsubToken groups by per-email cookie value", () => {
		const ut = "alice-utok";
		svc.upsertSubscription({
			email: "alice@example.com",
			type: "materia",
			scope: "IRPF",
			confirmToken: "ct1",
			unsubToken: ut,
			confirmed: true,
		});
		svc.upsertSubscription({
			email: "alice@example.com",
			type: "norma",
			scope: "BOE-A-1978-31229",
			confirmToken: "ct2",
			unsubToken: ut,
			confirmed: true,
		});

		const rows = svc.getSubscriptionsByUnsubToken(ut);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.email).toBe("alice@example.com");
		expect(new Set(rows.map((r) => r.type))).toEqual(
			new Set(["materia", "norma"]),
		);
	});
});
