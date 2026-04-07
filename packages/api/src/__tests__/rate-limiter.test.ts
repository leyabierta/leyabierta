import { describe, expect, test } from "bun:test";
import { createRateLimiter, getClientIp } from "../services/rate-limiter.ts";

describe("createRateLimiter", () => {
	test("allows requests under the limit", () => {
		const limiter = createRateLimiter(3, 60_000);
		expect(limiter.isLimited("1.2.3.4")).toBe(false);
		expect(limiter.isLimited("1.2.3.4")).toBe(false);
		expect(limiter.isLimited("1.2.3.4")).toBe(false);
	});

	test("blocks requests over the limit", () => {
		const limiter = createRateLimiter(2, 60_000);
		expect(limiter.isLimited("1.2.3.4")).toBe(false); // 1st
		expect(limiter.isLimited("1.2.3.4")).toBe(false); // 2nd
		expect(limiter.isLimited("1.2.3.4")).toBe(true); // 3rd = blocked
		expect(limiter.isLimited("1.2.3.4")).toBe(true); // still blocked
	});

	test("tracks IPs independently", () => {
		const limiter = createRateLimiter(1, 60_000);
		expect(limiter.isLimited("1.1.1.1")).toBe(false);
		expect(limiter.isLimited("2.2.2.2")).toBe(false);
		expect(limiter.isLimited("1.1.1.1")).toBe(true);
		expect(limiter.isLimited("2.2.2.2")).toBe(true);
	});

	test("resets after window expires", () => {
		const limiter = createRateLimiter(1, 1); // 1ms window
		expect(limiter.isLimited("1.2.3.4")).toBe(false);
		expect(limiter.isLimited("1.2.3.4")).toBe(true);

		// Wait for window to expire
		const start = Date.now();
		while (Date.now() - start < 5) {} // busy-wait 5ms

		expect(limiter.isLimited("1.2.3.4")).toBe(false);
	});
});

describe("getClientIp", () => {
	test("extracts from X-Forwarded-For (first IP)", () => {
		const req = new Request("http://localhost", {
			headers: { "x-forwarded-for": "203.0.113.1, 70.41.3.18" },
		});
		expect(getClientIp(req)).toBe("203.0.113.1");
	});

	test("falls back to CF-Connecting-IP", () => {
		const req = new Request("http://localhost", {
			headers: { "cf-connecting-ip": "198.51.100.1" },
		});
		expect(getClientIp(req)).toBe("198.51.100.1");
	});

	test("falls back to X-Real-IP", () => {
		const req = new Request("http://localhost", {
			headers: { "x-real-ip": "192.0.2.1" },
		});
		expect(getClientIp(req)).toBe("192.0.2.1");
	});

	test("returns 'unknown' when no headers present", () => {
		const req = new Request("http://localhost");
		expect(getClientIp(req)).toBe("unknown");
	});

	test("prefers CF-Connecting-IP over X-Forwarded-For", () => {
		const req = new Request("http://localhost", {
			headers: {
				"x-forwarded-for": "203.0.113.1",
				"cf-connecting-ip": "198.51.100.1",
			},
		});
		expect(getClientIp(req)).toBe("198.51.100.1");
	});
});
