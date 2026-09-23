/**
 * Rate limiter — IP-based, fixed window, in-memory.
 *
 * Shared by global API middleware and alert endpoints.
 */

import { timingSafeEqual } from "node:crypto";

interface RateEntry {
	count: number;
	resetAt: number;
}

export function createRateLimiter(maxRequests: number, windowMs = 60 * 1000) {
	const map = new Map<string, RateEntry>();

	// Periodically clean expired entries (every 10 minutes)
	setInterval(
		() => {
			const now = Date.now();
			for (const [ip, entry] of map) {
				if (now >= entry.resetAt) map.delete(ip);
			}
		},
		10 * 60 * 1000,
	);

	return {
		isLimited(ip: string): boolean {
			const now = Date.now();
			const entry = map.get(ip);

			if (!entry || now >= entry.resetAt) {
				map.set(ip, { count: 1, resetAt: now + windowMs });
				return false;
			}

			if (entry.count >= maxRequests) return true;

			entry.count++;
			return false;
		},
	};
}

export function getClientIp(request: Request): string {
	return (
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

/**
 * Client IP for the question quota (services/ask-quota.ts).
 *
 * Stricter than getClientIp: only CF-Connecting-IP is trusted. In production
 * the API port is bound to 127.0.0.1 and the only way in is the Cloudflare
 * Tunnel; Cloudflare sets CF-Connecting-IP itself, overwriting any value the
 * visitor sends, so it cannot be forged from the internet. X-Forwarded-For /
 * X-Real-IP are ignored here because any caller can set them. Without
 * CF-Connecting-IP (local dev, scripts on the host) we use the socket
 * address, and only then a shared "unknown" bucket.
 */
export function getQuotaClientIp(
	request: Request,
	server?: { requestIP(req: Request): { address: string } | null } | null,
): string {
	const cf = request.headers.get("cf-connecting-ip")?.trim();
	if (cf) return cf;
	try {
		const socket = server?.requestIP(request)?.address;
		if (socket) return socket;
	} catch {
		/* not available when the app is driven via app.handle() */
	}
	return "unknown";
}

/** Constant-time check of the X-API-Key bypass header. */
export function hasBypassKey(request: Request, bypassKey: string): boolean {
	if (!bypassKey) return false;
	const apiKey = request.headers.get("x-api-key") ?? "";
	return (
		apiKey.length === bypassKey.length &&
		timingSafeEqual(Buffer.from(apiKey), Buffer.from(bypassKey))
	);
}
