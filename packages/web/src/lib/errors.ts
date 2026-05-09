/**
 * Standardized error handling utilities.
 *
 * This module provides custom error classes and utilities for consistent
 * error handling across the application.
 */

/**
 * API error with status code and additional context.
 *
 * @example
 * ```ts
 * throw new ApiError(404, "Law not found", "/v1/laws/BOE-A-1978-31229");
 * ```
 */
export class ApiError extends Error {
	public readonly status: number;
	public readonly path: string;

	constructor(status: number, message: string, path: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.path = path;
	}
}

/**
 * Network error (fetch failures, timeouts, etc.).
 *
 * @example
 * ```ts
 * throw new NetworkError("Failed to fetch: Network request failed");
 * ```
 */
export class NetworkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NetworkError";
	}
}

/**
 * Validation error (invalid input, malformed data, etc.).
 *
 * @example
 * ```ts
 * throw new ValidationError("Invalid law ID format");
 * ```
 */
class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

/**
 * Standardize error handling for API responses.
 *
 * Converts various error types into standardized error classes.
 *
 * @param err - The error to handle
 * @param path - The API endpoint path
 * @throws ApiError for API errors
 * @throws NetworkError for network failures
 * @throws Error for unknown errors
 */
function handleApiError(err: unknown, path: string): never {
	if (err instanceof ApiError) {
		throw err;
	}

	if (err instanceof TypeError) {
		// fetch network failures
		throw new NetworkError(`Network error: ${err.message}`);
	}

	if (err instanceof Error) {
		// Check if it's a retryable API error
		if (err.message.includes("(retryable)")) {
			throw err; // Let caller handle retry logic
		}

		if (err.message.startsWith("API ")) {
			// Already formatted as API error
			const match = err.message.match(/API (\d+):/);
			const status = match ? Number.parseInt(match[1], 10) : 500;
			throw new ApiError(status, err.message.replace(`API ${status}: `, ""), path);
		}

		// Generic error
		throw new Error(`Unexpected error: ${err.message}`);
	}

	// Unknown error type
	throw new Error("Unknown error occurred");
}

/**
 * Check if an error is retryable.
 *
 * Returns true for:
 * - 5xx API errors (server errors)
 * - Network errors
 * - Errors marked as "(retryable)"
 *
 * @param err - The error to check
 * @returns True if the error should be retried
 */
export function isRetryableError(err: unknown): boolean {
	if (err instanceof ApiError) {
		// Retry on 5xx errors, not on 4xx
		return err.status >= 500;
	}

	if (err instanceof NetworkError) {
		return true;
	}

	if (err instanceof Error && err.message.includes("(retryable)")) {
		return true;
	}

	return false;
}

/**
 * Format error message for user display.
 *
 * Converts technical errors into user-friendly Spanish messages.
 *
 * @param err - The error to format
 * @returns User-friendly error message in Spanish
 */
function formatErrorMessage(err: unknown): string {
	if (err instanceof ApiError) {
		if (err.status >= 500) {
			return "Error del servidor. Por favor, inténtalo de nuevo más tarde.";
		}
		if (err.status === 401) {
			return "No autorizado. Por favor, inicia sesión.";
		}
		if (err.status === 403) {
			return "Acceso denegado.";
		}
		if (err.status === 404) {
			return "Recurso no encontrado.";
		}
		return "Ha ocurrido un error. Por favor, inténtalo de nuevo.";
	}

	if (err instanceof NetworkError) {
		return "Error de conexión. Por favor, comprueba tu internet e inténtalo de nuevo.";
	}

	if (err instanceof ValidationError) {
		return err.message;
	}

	if (err instanceof Error) {
		return "Ha ocurrido un error inesperado.";
	}

	return "Ha ocurrido un error desconocido.";
}
