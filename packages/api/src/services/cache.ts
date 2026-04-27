/**
 * Simple LRU cache for API responses.
 *
 * In-memory Map with max size eviction. Optional TTL — if `ttlMs > 0` is
 * supplied at construction, expired entries are skipped on read and dropped.
 * Upgrade to Redis when needed.
 */

interface Entry<V> {
	value: V;
	expiresAt: number; // epoch ms; Infinity means no expiry
}

export class LruCache<V> {
	private map = new Map<string, Entry<V>>();

	constructor(
		private maxSize: number = 500,
		private ttlMs: number = 0,
	) {}

	get(key: string): V | undefined {
		const entry = this.map.get(key);
		if (entry === undefined) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.map.delete(key);
			return undefined;
		}
		// Move to end (most recently used)
		this.map.delete(key);
		this.map.set(key, entry);
		return entry.value;
	}

	set(key: string, value: V): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.maxSize) {
			// Evict oldest (first entry)
			const firstKey = this.map.keys().next().value;
			if (firstKey !== undefined) {
				this.map.delete(firstKey);
			}
		}
		const expiresAt =
			this.ttlMs > 0 ? Date.now() + this.ttlMs : Number.POSITIVE_INFINITY;
		this.map.set(key, { value, expiresAt });
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}
