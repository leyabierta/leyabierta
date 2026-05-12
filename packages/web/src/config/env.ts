/**
 * Centralized environment variable configuration.
 *
 * This module provides a single source of truth for all environment variables
 * used in the application, with type safety and default values.
 */

export const config = {
	api: {
		baseUrl: import.meta.env.PUBLIC_API_URL ?? "https://api.leyabierta.es",
		bypassKey: import.meta.env.API_BYPASS_KEY ?? "",
	},
	app: {
		name: "Ley Abierta",
		url: import.meta.env.PUBLIC_URL ?? "https://leyabierta.es",
	},
	features: {
		analytics: import.meta.env.PUBLIC_ENABLE_ANALYTICS !== "false",
	},
} as const;
