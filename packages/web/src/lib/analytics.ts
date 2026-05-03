// Privacy-first analytics helper for Umami (self-hosted).
//
// The Umami tracker script is loaded with `defer` from analytics.leyabierta.es,
// so window.umami may be undefined when this module first runs. Calls to
// track() before the script loads are queued and flushed once umami appears.
//
// Compliant with AEPD criteria for analytics without cookie consent:
// no cookies, no UserID, no fingerprinting, no cross-site tracking.

declare global {
	interface Window {
		umami?: {
			track: (event: string, data?: Record<string, unknown>) => void;
		};
	}
}

const queue: Array<[string, Record<string, unknown>?]> = [];
let flushed = false;

function flushIfReady(): void {
	if (flushed || !window.umami) return;
	while (queue.length) {
		const [event, data] = queue.shift() as [string, Record<string, unknown>?];
		window.umami.track(event, data);
	}
	flushed = true;
}

/**
 * Track a custom event. Safe in SSR (no-op when window is undefined).
 * Queues events that fire before the Umami tracker loads (typical first-paint window).
 */
export function track(event: string, data?: Record<string, unknown>): void {
	if (typeof window === "undefined") return;

	if (window.umami) {
		window.umami.track(event, data);
		return;
	}

	queue.push([event, data]);
	requestAnimationFrame(flushIfReady);
	// Backstop: 2s later, retry. If umami never loads (adblocker, network),
	// queued events stay in memory and are lost on tab close. Acceptable.
	setTimeout(flushIfReady, 2000);
}

// PII patterns common in legal-search queries on a Spanish site.
// Bias is toward false positives (privacy first): if any pattern matches,
// the query is dropped from the tracking payload.
const PII_PATTERNS: RegExp[] = [
	/\b\d{8}[A-HJ-NP-TV-Z]\b/i, // DNI
	/\b[XYZ]\d{7}[A-HJ-NP-TV-Z]\b/i, // NIE
	/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, // email
	/\b(?:\+?34)?[\s-]?[679]\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/, // tel ES
];

export interface SanitizedQuery {
	query?: string;
	had_pii: boolean;
}

/**
 * Sanitize a search query for tracking.
 * Returns { had_pii: true } if any PII pattern matches (query is dropped).
 * Otherwise returns the query truncated to 100 chars.
 */
export function sanitizeQueryForTracking(q: string): SanitizedQuery {
	if (PII_PATTERNS.some((p) => p.test(q))) {
		return { had_pii: true };
	}
	return { query: q.slice(0, 100), had_pii: false };
}

/**
 * Send an outbound-click event using sendBeacon so the request survives
 * navigation. Falls back to no-op if sendBeacon is unavailable.
 *
 * sendBeacon requires a Blob with explicit MIME type for Umami to accept JSON.
 */
export function sendOutboundClick(
	href: string,
	extra?: Record<string, unknown>,
): void {
	if (
		typeof navigator === "undefined" ||
		typeof navigator.sendBeacon !== "function"
	)
		return;
	const websiteId = import.meta.env.PUBLIC_UMAMI_WEBSITE_ID as
		| string
		| undefined;
	if (!websiteId) return;

	const payload = {
		type: "event",
		payload: {
			website: websiteId,
			hostname: window.location.hostname,
			language: navigator.language,
			screen: `${window.screen.width}x${window.screen.height}`,
			url: window.location.pathname,
			name: "outbound_click",
			data: { destination: href, ...extra },
		},
	};

	const blob = new Blob([JSON.stringify(payload)], {
		type: "application/json",
	});
	navigator.sendBeacon("https://analytics.leyabierta.es/data/event", blob);
}

/**
 * Initialize a 75% scroll-depth observer for the current page.
 * Fires `scroll_depth_75` exactly once per pageview, with reset on the
 * `pageshow` event so back/forward cache navigation re-arms the trigger.
 *
 * Pass an element ref for the sentinel (an empty div positioned at 75% of
 * the article container is the typical pattern). If null/undefined, no-op.
 */
export function initScrollDepth(
	sentinel: Element | null,
	eventData?: Record<string, unknown>,
): void {
	if (!sentinel || typeof IntersectionObserver === "undefined") return;
	let fired = false;

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting && !fired) {
					fired = true;
					track("scroll_depth_75", eventData);
					observer.disconnect();
				}
			}
		},
		{ threshold: 0.1 },
	);
	observer.observe(sentinel);

	// Reset on bfcache navigation so the trigger re-arms on the same page.
	window.addEventListener("pageshow", (e) => {
		if (e.persisted) {
			fired = false;
			observer.observe(sentinel);
		}
	});
}

/**
 * Debounce helper for search-as-you-type tracking.
 * Returns a callable that fires `event` only after `delay` ms of quiet.
 * Calling .flush() fires immediately (use on Enter / explicit submit).
 */
export function debouncedTrack(
	event: string,
	delay = 500,
): {
	fire: (data?: Record<string, unknown>) => void;
	flush: (data?: Record<string, unknown>) => void;
} {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastData: Record<string, unknown> | undefined;

	return {
		fire(data) {
			lastData = data;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				track(event, lastData);
				timer = undefined;
			}, delay);
		},
		flush(data) {
			if (timer) clearTimeout(timer);
			timer = undefined;
			track(event, data ?? lastData);
		},
	};
}
