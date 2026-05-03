/**
 * Tests for the privacy-first analytics helper.
 *
 * Covered:
 * - track() is a no-op in SSR (no window)
 * - track() queues events when window.umami is missing and flushes when it appears
 * - sanitizeQueryForTracking() detects DNI/NIE/email/phone PII patterns
 * - sanitizeQueryForTracking() truncates clean queries to 100 chars
 * - sendOutboundClick() uses sendBeacon with Blob(application/json)
 * - debouncedTrack() coalesces rapid calls and supports flush()
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
	debouncedTrack,
	sanitizeQueryForTracking,
	sendOutboundClick,
	track,
} from "../lib/analytics.ts";

// ---------- DOM stubs (bun:test runs without jsdom by default) ----------

interface UmamiStub {
	track: ReturnType<typeof mock>;
}

function installWindow(umami?: UmamiStub) {
	const win: Record<string, unknown> = {
		umami,
		requestAnimationFrame: (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		},
		setTimeout: (cb: () => void, _ms: number) => {
			cb();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: () => undefined,
		location: {
			hostname: "leyabierta.es",
			pathname: "/leyes/BOE-A-1978-31229",
		},
		screen: { width: 1920, height: 1080 },
	};
	(globalThis as { window?: unknown }).window = win;
	(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame =
		win.requestAnimationFrame;
	(globalThis as { setTimeout?: unknown }).setTimeout = win.setTimeout;
	(globalThis as { clearTimeout?: unknown }).clearTimeout = win.clearTimeout;
	(globalThis as { navigator?: unknown }).navigator = {
		language: "es-ES",
		sendBeacon: mock(() => true),
	};
	(globalThis as { Blob?: unknown }).Blob =
		(globalThis as { Blob?: typeof Blob }).Blob ??
		class FakeBlob {
			parts: BlobPart[];
			type: string;
			constructor(parts: BlobPart[], opts?: BlobPropertyBag) {
				this.parts = parts;
				this.type = opts?.type ?? "";
			}
		};
}

function uninstallWindow() {
	(globalThis as { window?: unknown }).window = undefined;
	(globalThis as { navigator?: unknown }).navigator = undefined;
}

// ---------- track() ----------

describe("track()", () => {
	afterEach(uninstallWindow);

	it("is a no-op when window is undefined (SSR safety)", () => {
		uninstallWindow();
		expect(() => track("test_event")).not.toThrow();
	});

	it("calls window.umami.track immediately when umami is loaded", () => {
		const umami = { track: mock(() => undefined) };
		installWindow(umami);
		track("digest_subscribe_attempt", { digest: "sanitario" });
		expect(umami.track).toHaveBeenCalledWith("digest_subscribe_attempt", {
			digest: "sanitario",
		});
	});

	it("queues events when umami is missing, flushes via rAF backstop once it arrives", () => {
		// Install window WITHOUT umami first.
		installWindow(undefined);
		// Make rAF defer until we say so.
		const rafCallbacks: FrameRequestCallback[] = [];
		(
			globalThis as {
				window: { requestAnimationFrame: typeof requestAnimationFrame };
			}
		).window.requestAnimationFrame = (cb: FrameRequestCallback) => {
			rafCallbacks.push(cb);
			return 0;
		};
		(
			globalThis as { requestAnimationFrame: typeof requestAnimationFrame }
		).requestAnimationFrame = (cb: FrameRequestCallback) => {
			rafCallbacks.push(cb);
			return 0;
		};
		// setTimeout: never fire (we want to test rAF path).
		(globalThis as { setTimeout: unknown }).setTimeout = () => 0;

		track("search_submit", { len: 5 });

		// Now Umami "loads" between fire and flush.
		const umami = { track: mock(() => undefined) };
		(globalThis as { window: { umami?: UmamiStub } }).window.umami = umami;

		// Fire the queued rAF callbacks.
		for (const cb of rafCallbacks) cb(0);

		expect(umami.track).toHaveBeenCalledTimes(1);
		expect(umami.track).toHaveBeenCalledWith("search_submit", { len: 5 });
	});
});

// ---------- sanitizeQueryForTracking() ----------

describe("sanitizeQueryForTracking()", () => {
	it("detects valid Spanish DNI (8 digits + letter)", () => {
		expect(sanitizeQueryForTracking("12345678Z reforma laboral")).toEqual({
			had_pii: true,
		});
	});

	it("detects valid Spanish NIE (X/Y/Z + 7 digits + letter)", () => {
		expect(sanitizeQueryForTracking("X1234567L permiso")).toEqual({
			had_pii: true,
		});
	});

	it("detects email addresses", () => {
		expect(sanitizeQueryForTracking("ayuda usuario@example.com")).toEqual({
			had_pii: true,
		});
	});

	it("detects Spanish phone numbers with country prefix and separators", () => {
		expect(sanitizeQueryForTracking("llama al +34 612 345 678")).toEqual({
			had_pii: true,
		});
		expect(sanitizeQueryForTracking("612345678 ayuda")).toEqual({
			had_pii: true,
		});
	});

	it("returns clean queries unchanged (under 100 chars)", () => {
		const result = sanitizeQueryForTracking("ley de educacion");
		expect(result.had_pii).toBe(false);
		expect(result.query).toBe("ley de educacion");
	});

	it("truncates clean queries longer than 100 chars", () => {
		const long = "a".repeat(150);
		const result = sanitizeQueryForTracking(long);
		expect(result.had_pii).toBe(false);
		expect(result.query?.length).toBe(100);
	});

	it("does not match digits without DNI letter (just numbers)", () => {
		// 8 digits without final letter = not a DNI under our regex.
		const result = sanitizeQueryForTracking("articulo 12345678 boe");
		expect(result.had_pii).toBe(false);
	});
});

// ---------- sendOutboundClick() ----------

describe("sendOutboundClick()", () => {
	beforeEach(() => {
		installWindow();
		(
			import.meta.env as { PUBLIC_UMAMI_WEBSITE_ID?: string }
		).PUBLIC_UMAMI_WEBSITE_ID = "test-uuid";
	});
	afterEach(() => {
		(
			import.meta.env as { PUBLIC_UMAMI_WEBSITE_ID?: string }
		).PUBLIC_UMAMI_WEBSITE_ID = undefined;
		uninstallWindow();
	});

	it("calls sendBeacon with a Blob of application/json type", () => {
		const beacon = mock(() => true);
		(
			globalThis as { navigator: { sendBeacon: typeof beacon } }
		).navigator.sendBeacon = beacon;

		sendOutboundClick("https://www.boe.es/eli/es/c/1978/12/27/(1)", {
			law_id: "BOE-A-1978-31229",
		});

		expect(beacon).toHaveBeenCalledTimes(1);
		const [url, body] = beacon.mock.calls[0] as [string, Blob];
		expect(url).toBe("https://analytics.leyabierta.es/data/event");
		// Bun's Blob normalizes the MIME type; just verify the prefix.
		expect((body as { type: string }).type.startsWith("application/json")).toBe(
			true,
		);
	});

	it("is a no-op when sendBeacon is unavailable", () => {
		(
			globalThis as { navigator: { sendBeacon?: unknown } }
		).navigator.sendBeacon = undefined;
		expect(() => sendOutboundClick("https://example.com")).not.toThrow();
	});

	it("is a no-op when website ID env var is missing", () => {
		(
			import.meta.env as { PUBLIC_UMAMI_WEBSITE_ID?: string }
		).PUBLIC_UMAMI_WEBSITE_ID = undefined;
		const beacon = mock(() => true);
		(
			globalThis as { navigator: { sendBeacon: typeof beacon } }
		).navigator.sendBeacon = beacon;
		sendOutboundClick("https://example.com");
		expect(beacon).not.toHaveBeenCalled();
	});
});

// ---------- debouncedTrack() ----------

describe("debouncedTrack()", () => {
	afterEach(uninstallWindow);

	it("debounces rapid calls and fires once after the delay", () => {
		const umami = { track: mock(() => undefined) };
		installWindow(umami);
		// Make setTimeout deferred so we control timing.
		let pending: (() => void) | undefined;
		(globalThis as { setTimeout: unknown }).setTimeout = (cb: () => void) => {
			pending = cb;
			return 42; // non-zero so the source's `if (timer)` truthiness check passes
		};
		(globalThis as { clearTimeout: unknown }).clearTimeout = () => {
			pending = undefined;
		};

		const debounced = debouncedTrack("search_submit", 500);
		debounced.fire({ q: "le" });
		debounced.fire({ q: "ley" });
		debounced.fire({ q: "ley educa" });

		expect(umami.track).not.toHaveBeenCalled();
		// Trigger the timer.
		pending?.();

		expect(umami.track).toHaveBeenCalledTimes(1);
		expect(umami.track).toHaveBeenCalledWith("search_submit", {
			q: "ley educa",
		});
	});

	it("flush() fires immediately and clears any pending timer", () => {
		const umami = { track: mock(() => undefined) };
		installWindow(umami);
		let pending: (() => void) | undefined;
		(globalThis as { setTimeout: unknown }).setTimeout = (cb: () => void) => {
			pending = cb;
			return 42; // non-zero so the source's `if (timer)` truthiness check passes
		};
		(globalThis as { clearTimeout: unknown }).clearTimeout = () => {
			pending = undefined;
		};

		const debounced = debouncedTrack("search_submit", 500);
		debounced.fire({ q: "ley" });
		debounced.flush({ q: "ley educacion" });

		expect(umami.track).toHaveBeenCalledTimes(1);
		expect(umami.track).toHaveBeenCalledWith("search_submit", {
			q: "ley educacion",
		});
		expect(pending).toBeUndefined();
	});
});
