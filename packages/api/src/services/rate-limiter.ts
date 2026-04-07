/**
 * Rate limiter — IP-based, fixed window, in-memory.
 *
 * Shared by global API middleware and alert endpoints.
 */

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
