/**
 * Smoke test for the RSS memory pressure probe.
 *
 * Verifies that startMemProbe is exported and callable without crashing (the
 * timer itself is unref'd, so running it in a test is harmless on Linux but
 * we don't depend on /proc being present in CI — the function must handle
 * both cases without throwing).
 */

import { describe, expect, test } from "bun:test";
import { startMemProbe } from "../services/mem-probe.ts";

describe("mem-probe", () => {
	test("startMemProbe is exported and is a function", () => {
		expect(typeof startMemProbe).toBe("function");
	});

	test("startMemProbe does not throw on any platform", () => {
		// On Linux it may start a timer (unref'd — won't block test exit).
		// On macOS/Windows it logs once and returns.
		expect(() => startMemProbe()).not.toThrow();
	});
});
