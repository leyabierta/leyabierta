/**
 * Tiny async semaphore. NaN's hard cap is 5 concurrent requests across the
 * whole account, so this is a module-level singleton shared by every client
 * created in this package (Qwen + Gemma + judges + alt-finder all funnel
 * through it).
 */

export class Semaphore {
	private inFlight = 0;
	private queue: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async acquire(): Promise<void> {
		if (this.inFlight < this.limit) {
			this.inFlight++;
			return;
		}
		await new Promise<void>((resolve) => this.queue.push(resolve));
		this.inFlight++;
	}

	release(): void {
		this.inFlight--;
		const next = this.queue.shift();
		if (next) next();
	}

	get stats() {
		return { inFlight: this.inFlight, queued: this.queue.length };
	}
}

/** Singleton across the eval package — NaN's 5-concurrent cap. */
export const NAN_SEMAPHORE = new Semaphore(5);

export async function withSemaphore<T>(
	sem: Semaphore,
	fn: () => Promise<T>,
): Promise<T> {
	await sem.acquire();
	try {
		return await fn();
	} finally {
		sem.release();
	}
}
