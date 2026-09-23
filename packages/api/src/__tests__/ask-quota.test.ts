import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { askRoutes } from "../routes/ask.ts";
import {
	AskQuota,
	type AskQuotaLimits,
	askLimitsFromEnv,
	normalizeIp,
} from "../services/ask-quota.ts";
import { defaultCacheControl } from "../services/cache-control.ts";
import type { RagPipeline } from "../services/rag/pipeline.ts";
import { getQuotaClientIp } from "../services/rate-limiter.ts";

// 2026-09-23 12:00 in Madrid (CEST, UTC+2)
const NOON_MADRID = Date.parse("2026-09-23T10:00:00Z");
const LIMITS: AskQuotaLimits = { perMinute: 2, perDay: 10, globalPerDay: 200 };

function makeClock(start = NOON_MADRID) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		set: (ms: number) => {
			t = ms;
		},
	};
}

const quotas: AskQuota[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
	for (const q of quotas.splice(0)) q.close();
	for (const d of tmpDirs.splice(0))
		rmSync(d, { recursive: true, force: true });
});

function makeQuota(
	clock: ReturnType<typeof makeClock>,
	limits: AskQuotaLimits = LIMITS,
	path = ":memory:",
) {
	let n = 0;
	const q = new AskQuota({
		limits,
		path,
		now: clock.now,
		generateSalt: () => Buffer.alloc(32, ++n),
	});
	quotas.push(q);
	return q;
}

/** Spend `n` questions from `ip`, spacing them so the minute window never trips. */
function spend(
	q: AskQuota,
	clock: ReturnType<typeof makeClock>,
	ip: string,
	n: number,
) {
	for (let i = 0; i < n; i++) {
		expect(q.consume(ip).allowed).toBe(true);
		clock.advance(61_000);
	}
}

describe("AskQuota — per person", () => {
	test("allows 2 per minute, then 429 per_minute with Retry-After", () => {
		const clock = makeClock();
		const q = makeQuota(clock);
		expect(q.consume("203.0.113.1")).toMatchObject({
			allowed: true,
			remainingToday: 9,
		});
		clock.advance(10_000);
		expect(q.consume("203.0.113.1")).toMatchObject({
			allowed: true,
			remainingToday: 8,
		});
		clock.advance(5_000);
		const denied = q.consume("203.0.113.1");
		expect(denied).toMatchObject({
			allowed: false,
			reason: "per_minute",
			message: "Has hecho muchas preguntas seguidas. Espera un minuto.",
			remainingToday: 8,
		});
		// Window opened at t0, now is t0+15s → 45s left
		if (!denied.allowed) expect(denied.retryAfterSeconds).toBe(45);

		clock.advance(45_000);
		expect(q.consume("203.0.113.1").allowed).toBe(true);
	});

	test("a denied request does not count", () => {
		const clock = makeClock();
		const q = makeQuota(clock);
		q.consume("203.0.113.1");
		q.consume("203.0.113.1");
		for (let i = 0; i < 5; i++) q.consume("203.0.113.1"); // all per_minute
		clock.advance(60_000);
		expect(q.consume("203.0.113.1")).toMatchObject({
			allowed: true,
			remainingToday: 7,
		});
	});

	test("allows 10 per day, then 429 per_day until Madrid midnight", () => {
		const clock = makeClock();
		const q = makeQuota(clock);
		spend(q, clock, "203.0.113.1", 10);
		const denied = q.consume("203.0.113.1");
		expect(denied).toMatchObject({
			allowed: false,
			reason: "per_day",
			message: "Has alcanzado el límite de 10 preguntas al día. Vuelve mañana.",
			remainingToday: 0,
		});
		// 10 questions × 61s after 12:00:00 → 12:10:10 Madrid
		if (!denied.allowed)
			expect(denied.retryAfterSeconds).toBe(
				86_400 - (12 * 3600 + 10 * 60 + 10),
			);
	});

	test("per-day wins over per-minute when both apply", () => {
		const clock = makeClock();
		const q = makeQuota(clock, { perMinute: 2, perDay: 2, globalPerDay: 200 });
		q.consume("203.0.113.1");
		q.consume("203.0.113.1");
		expect(q.consume("203.0.113.1")).toMatchObject({ reason: "per_day" });
	});

	test("people are counted independently", () => {
		const clock = makeClock();
		const q = makeQuota(clock);
		spend(q, clock, "203.0.113.1", 10);
		expect(q.consume("203.0.113.1").allowed).toBe(false);
		expect(q.consume("198.51.100.7")).toMatchObject({
			allowed: true,
			remainingToday: 9,
		});
	});

	test("addresses in the same IPv6 /64 share one quota", () => {
		const clock = makeClock();
		const q = makeQuota(clock, { perMinute: 1, perDay: 10, globalPerDay: 200 });
		expect(q.consume("2001:db8:1:2::aaaa").allowed).toBe(true);
		expect(q.consume("2001:db8:1:2:ffff:1:2:3")).toMatchObject({
			allowed: false,
			reason: "per_minute",
		});
		expect(q.consume("2001:db8:1:3::1").allowed).toBe(true);
	});
});

describe("AskQuota — global cap", () => {
	test("stops everyone once the day's global budget is spent", () => {
		const clock = makeClock();
		const q = makeQuota(clock, { perMinute: 2, perDay: 10, globalPerDay: 3 });
		expect(q.consume("192.0.2.1").allowed).toBe(true);
		expect(q.consume("192.0.2.2").allowed).toBe(true);
		expect(q.consume("192.0.2.3").allowed).toBe(true);
		const denied = q.consume("192.0.2.4");
		expect(denied).toMatchObject({
			allowed: false,
			reason: "global_day",
			message:
				"El servicio de preguntas ha alcanzado su límite diario. Vuelve mañana.",
			remainingToday: 10,
		});
	});

	test("global cap resets at the next Madrid day", () => {
		// 23:59:00 Madrid on 2026-09-23
		const clock = makeClock(Date.parse("2026-09-23T21:59:00Z"));
		const q = makeQuota(clock, { perMinute: 2, perDay: 10, globalPerDay: 1 });
		expect(q.consume("192.0.2.1").allowed).toBe(true);
		const denied = q.consume("192.0.2.2");
		expect(denied).toMatchObject({ reason: "global_day" });
		if (!denied.allowed) expect(denied.retryAfterSeconds).toBe(60);
		clock.advance(61_000); // 00:00:01 on 2026-09-24
		expect(q.consume("192.0.2.2").allowed).toBe(true);
	});
});

describe("AskQuota — day rollover, hashing and storage", () => {
	test("per-day quota resets after Madrid midnight, not UTC midnight", () => {
		// 23:50 Madrid = 21:50 UTC
		const clock = makeClock(Date.parse("2026-09-23T21:50:00Z"));
		const q = makeQuota(clock, { perMinute: 5, perDay: 2, globalPerDay: 200 });
		q.consume("203.0.113.1");
		q.consume("203.0.113.1");
		expect(q.consume("203.0.113.1")).toMatchObject({ reason: "per_day" });
		clock.set(Date.parse("2026-09-23T22:00:01Z")); // 00:00:01 Madrid
		expect(q.consume("203.0.113.1")).toMatchObject({
			allowed: true,
			remainingToday: 1,
		});
	});

	test("the client hash rotates daily and never contains the IP", () => {
		const clock = makeClock();
		const q = makeQuota(clock);
		const today = q.clientKey("203.0.113.1");
		expect(today).toMatch(/^[0-9a-f]{32}$/);
		expect(q.clientKey("203.0.113.1")).toBe(today); // stable within the day
		clock.advance(24 * 3600 * 1000);
		q.purgeStale();
		expect(q.clientKey("203.0.113.1")).not.toBe(today);
	});

	test("stores only hashes, and purges yesterday's rows and salt", () => {
		const dir = mkdtempSync(join(tmpdir(), "ask-quota-"));
		tmpDirs.push(dir);
		const path = join(dir, "q.db");
		const clock = makeClock();
		const q = makeQuota(clock, LIMITS, path);
		q.consume("203.0.113.1");

		const peek = new Database(path, { readonly: true });
		const rows = peek
			.query<{ day: string; client: string }, []>(
				"SELECT day, client FROM ask_quota",
			)
			.all();
		expect(rows.map((r) => r.day)).toEqual(["2026-09-23", "2026-09-23"]);
		for (const r of rows) expect(r.client).not.toContain("203.0.113.1");
		peek.close();

		clock.advance(24 * 3600 * 1000);
		q.purgeStale();
		const after = new Database(path, { readonly: true });
		expect(after.query("SELECT COUNT(*) AS n FROM ask_quota").get()).toEqual({
			n: 0,
		});
		expect(
			after.query("SELECT COUNT(*) AS n FROM ask_quota_salt").get(),
		).toEqual({ n: 0 });
		after.close();
	});

	test("counters survive a restart (same file, new instance)", () => {
		const dir = mkdtempSync(join(tmpdir(), "ask-quota-"));
		tmpDirs.push(dir);
		const path = join(dir, "q.db");
		const clock = makeClock();
		const first = makeQuota(clock, LIMITS, path);
		spend(first, clock, "203.0.113.1", 4);
		first.close();
		quotas.splice(quotas.indexOf(first), 1);

		const second = makeQuota(clock, LIMITS, path);
		expect(second.consume("203.0.113.1")).toMatchObject({
			allowed: true,
			remainingToday: 5,
		});
	});

	test("falls back to in-memory counters when the file cannot be opened", () => {
		const clock = makeClock();
		const q = makeQuota(clock, LIMITS, "/nonexistent-dir/for/sure/q.db");
		expect(q.consume("203.0.113.1").allowed).toBe(true);
		expect(q.consume("203.0.113.1").allowed).toBe(true);
		expect(q.consume("203.0.113.1").allowed).toBe(false);
	});
});

describe("askLimitsFromEnv", () => {
	test("defaults to 2/min, 10/day, 200/day global", () => {
		expect(askLimitsFromEnv({})).toEqual({
			perMinute: 2,
			perDay: 10,
			globalPerDay: 200,
		});
	});

	test("reads overrides and ignores invalid values", () => {
		expect(
			askLimitsFromEnv({
				ASK_PER_MINUTE_LIMIT: "3",
				ASK_PER_DAY_LIMIT: "abc",
				ASK_GLOBAL_DAILY_LIMIT: "50",
			}),
		).toEqual({ perMinute: 3, perDay: 10, globalPerDay: 50 });
		expect(askLimitsFromEnv({ ASK_PER_DAY_LIMIT: "0" }).perDay).toBe(10);
	});
});

describe("normalizeIp", () => {
	test("keeps IPv4, unwraps IPv4-mapped IPv6, truncates IPv6 to /64", () => {
		expect(normalizeIp(" 203.0.113.1 ")).toBe("203.0.113.1");
		expect(normalizeIp("::ffff:203.0.113.1")).toBe("203.0.113.1");
		expect(normalizeIp("2001:DB8:0001:0002:aaaa::1")).toBe("2001:db8:1:2::/64");
		expect(normalizeIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
		expect(normalizeIp("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
		expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
	});
});

describe("getQuotaClientIp", () => {
	const server = { requestIP: () => ({ address: "10.0.0.5" }) };

	test("uses CF-Connecting-IP when present", () => {
		const req = new Request("http://x", {
			headers: { "cf-connecting-ip": "198.51.100.1" },
		});
		expect(getQuotaClientIp(req, server)).toBe("198.51.100.1");
	});

	test("ignores spoofable X-Forwarded-For / X-Real-IP, falls back to the socket", () => {
		const req = new Request("http://x", {
			headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" },
		});
		expect(getQuotaClientIp(req, server)).toBe("10.0.0.5");
	});

	test("returns 'unknown' with no header and no server", () => {
		expect(getQuotaClientIp(new Request("http://x"), null)).toBe("unknown");
	});
});

// ── Route integration ─────────────────────────────────────────────────

function stubPipeline(calls: { ask: number; stream: number }) {
	return {
		ask: async () => {
			calls.ask++;
			return {
				answer: "respuesta",
				citations: [],
				declined: false,
				meta: {},
			};
		},
		askStream: async function* () {
			calls.stream++;
			yield { type: "chunk", text: "hola" };
			yield { type: "done", citations: [], meta: {}, declined: true };
		},
	} as unknown as RagPipeline;
}

function buildApp(
	quota: AskQuota,
	calls = { ask: 0, stream: 0 },
	bypassKey = "",
) {
	return new Elysia()
		.onAfterHandle(({ set, path }) => {
			// Mirror index.ts: default policy only when the route set none.
			if (!set.headers["Cache-Control"]) {
				const cc = defaultCacheControl(path, set.status);
				if (cc) set.headers["Cache-Control"] = cc;
			}
		})
		.use(askRoutes(stubPipeline(calls), { quota, bypassKey }));
}

function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": "203.0.113.9",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

describe("ask routes + quota", () => {
	test("POST /v1/ask: counts accepted questions and returns 429 JSON", async () => {
		const clock = makeClock();
		const calls = { ask: 0, stream: 0 };
		const app = buildApp(makeQuota(clock), calls);
		const q = { question: "¿Cuántos días de vacaciones tengo?" };

		const r1 = await app.handle(post("/v1/ask", q));
		expect(r1.status).toBe(200);
		expect(r1.headers.get("x-ratelimit-remaining")).toBe("9");
		await app.handle(post("/v1/ask", q));
		const r3 = await app.handle(post("/v1/ask", q));
		expect(r3.status).toBe(429);
		expect(r3.headers.get("retry-after")).toBe("60");
		expect(r3.headers.get("cache-control")).toBe("no-store");
		expect(await r3.json()).toEqual({
			error: "Has hecho muchas preguntas seguidas. Espera un minuto.",
			reason: "per_minute",
			retryAfterSeconds: 60,
			remainingToday: 8,
			limitPerDay: 10,
		});
		expect(calls.ask).toBe(2);
	});

	test("validation errors are not counted", async () => {
		const clock = makeClock();
		const quota = makeQuota(clock);
		const app = buildApp(quota);
		for (let i = 0; i < 5; i++) {
			const r = await app.handle(post("/v1/ask", { question: "a" }));
			expect(r.status).toBe(400);
		}
		const r = await app.handle(post("/v1/ask", { nope: true }));
		expect(r.status).toBeGreaterThanOrEqual(400);
		expect(r.status).toBeLessThan(500);
		expect(quota.consume("203.0.113.9")).toMatchObject({
			allowed: true,
			remainingToday: 9,
		});
	});

	test("declined answers still count", async () => {
		const clock = makeClock();
		const quota = makeQuota(clock);
		const app = buildApp(quota);
		// the stub stream ends with declined: true
		const r = await app.handle(
			post("/v1/ask/stream", { question: "¿Qué tiempo hará mañana?" }),
		);
		expect(r.status).toBe(200);
		await r.text();
		expect(quota.consume("203.0.113.9")).toMatchObject({ remainingToday: 8 });
	});

	test("POST /v1/ask/stream: 429 JSON before any SSE byte", async () => {
		const clock = makeClock();
		const calls = { ask: 0, stream: 0 };
		const app = buildApp(
			makeQuota(clock, { perMinute: 5, perDay: 1, globalPerDay: 200 }),
			calls,
		);
		const q = { question: "¿Puede mi casero subirme el alquiler?" };

		const ok = await app.handle(post("/v1/ask/stream", q));
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toContain("text/event-stream");
		const text = await ok.text();
		expect(text).toContain("event: quota");
		expect(text).toContain('"remainingToday":0');

		const denied = await app.handle(post("/v1/ask/stream", q));
		expect(denied.status).toBe(429);
		expect(denied.headers.get("content-type")).toContain("application/json");
		expect(denied.headers.get("cache-control")).toBe("no-store");
		expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
		const body = (await denied.json()) as { reason: string; error: string };
		expect(body.reason).toBe("per_day");
		expect(body.error).toBe(
			"Has alcanzado el límite de 1 preguntas al día. Vuelve mañana.",
		);
		expect(calls.stream).toBe(1); // the pipeline never ran for the 429
	});

	test("the bypass key skips the quota", async () => {
		const clock = makeClock();
		const quota = makeQuota(clock, {
			perMinute: 1,
			perDay: 1,
			globalPerDay: 1,
		});
		const app = buildApp(quota, undefined, "secret-key");
		const q = { question: "¿Cuántos días de vacaciones tengo?" };
		for (let i = 0; i < 3; i++) {
			const r = await app.handle(
				post("/v1/ask", q, { "x-api-key": "secret-key" }),
			);
			expect(r.status).toBe(200);
		}
		expect(quota.consume("203.0.113.9").allowed).toBe(true);
	});

	test("/_eval/retrieval needs the bypass key when one is configured", async () => {
		const app = buildApp(makeQuota(makeClock()), undefined, "secret-key");
		const r = await app.handle(
			post("/v1/_eval/retrieval", { question: "¿vacaciones?" }),
		);
		expect(r.status).toBe(404);
	});
});
