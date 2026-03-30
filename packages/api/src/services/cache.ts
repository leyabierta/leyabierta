/**
 * Simple LRU cache for API responses.
 *
 * In-memory Map with max size eviction.
 * Upgrade to Redis when needed.
 */

export class LruCache<V> {
	private map = new Map<string, V>();

	constructor(private maxSize: number = 500) {}

	get(key: string): V | undefined {
		const value = this.map.get(key);
		if (value !== undefined) {
			// Move to end (most recently used)
			this.map.delete(key);
			this.map.set(key, value);
		}
		return value;
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
		this.map.set(key, value);
	}

	get size(): number {
		return this.map.size;
	}
}
