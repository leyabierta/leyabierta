import { resolve } from "node:path";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
	integrations: [react()],
	site: "https://leyabierta.es",
	adapter: cloudflare(),
	vite: {
		envDir: "../..",
		resolve: {
			alias: {
				entities: resolve("../../node_modules/entities/lib/esm/index.js"),
			},
		},
	},
	server: { port: Number(process.env.PORT) || 3000 },
	// Stays "static": ~12k law pages remain prebuilt files (Pages Free's 20k-file
	// limit). Only routes with `export const prerender = false` (the reform
	// detail page) become on-demand Pages Functions via the adapter.
	output: "static",
	trailingSlash: "always",
	build: {
		concurrency: 4,
	},
	experimental: {
		queuedRendering: {
			enabled: true,
			contentCache: true,
		},
	},
});
