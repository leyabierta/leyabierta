import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	applyResend,
	dropEmailTables,
	emailTableCounts,
	maskEmail,
	planResend,
} from "./remove-email-data.ts";

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify({ data }), { status });
}

describe("remove-email-data", () => {
	test("masks emails for the dry-run listing", () => {
		expect(maskEmail("ana.garcia@example.org")).toBe("a***@example.org");
	});

	test("counts and drops only the email tables that exist", () => {
		const db = new Database(":memory:");
		db.run("CREATE TABLE subscriptions (email TEXT)");
		db.run("CREATE TABLE norm_follows (email TEXT)");
		db.run("CREATE TABLE reform_summaries (norm_id TEXT)");
		db.run("INSERT INTO subscriptions VALUES ('a@b.es'), ('c@d.es')");
		expect(emailTableCounts(db)).toEqual({ subscriptions: 2, norm_follows: 0 });
		expect(dropEmailTables(db)).toEqual(["subscriptions", "norm_follows"]);
		expect(emailTableCounts(db)).toEqual({});
		const left = db
			.query("SELECT name FROM sqlite_master WHERE type='table'")
			.all();
		expect(left).toEqual([{ name: "reform_summaries" }]);
	});

	test("plans and deletes Resend contacts, then their audiences", async () => {
		const calls: string[] = [];
		const fake = async (url: string, init?: RequestInit) => {
			const path = url.replace("https://api.resend.com", "");
			calls.push(`${init?.method ?? "GET"} ${path}`);
			expect((init?.headers as Record<string, string>).Authorization).toBe(
				"Bearer k",
			);
			if (path === "/audiences") return json([{ id: "A1", name: "Alertas" }]);
			if (path === "/audiences/A1/contacts")
				return json([{ id: "C1", email: "x@y.es" }]);
			if (path === "/contacts") return json([], 404);
			return new Response(null, { status: 200 });
		};
		const plan = await planResend(fake, "k");
		expect(plan.audiences[0]?.contacts).toHaveLength(1);
		expect(plan.globalContacts).toEqual([]);
		const res = await applyResend(fake, "k", plan);
		expect(res).toEqual({ deleted: 2, failed: [] });
		expect(calls.slice(-2)).toEqual([
			"DELETE /audiences/A1/contacts/C1",
			"DELETE /audiences/A1",
		]);
	});

	test("a failed Resend deletion is reported, a 404 counts as done", async () => {
		const fake = async (url: string) =>
			url.endsWith("/C1")
				? new Response(null, { status: 500 })
				: new Response(null, { status: 404 });
		const res = await applyResend(fake, "k", {
			audiences: [{ id: "A1", name: "x", contacts: [{ id: "C1", email: "" }] }],
			globalContacts: [],
		});
		expect(res.deleted).toBe(1);
		expect(res.failed).toEqual(["/audiences/A1/contacts/C1 → HTTP 500"]);
	});
});
