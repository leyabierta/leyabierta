/**
 * Retry with exponential backoff.
 */

export interface RetryOptions {
	maxRetries?: number;
	baseDelayMs?: number;
	onRetry?: (attempt: number, error: unknown) => void;
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const { maxRetries = 3, baseDelayMs = 1000, onRetry } = options;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt === maxRetries) throw error;
			const delay = baseDelayMs * 2 ** attempt;
			onRetry?.(attempt + 1, error);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw new Error("unreachable");
}
