import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
	integrations: [react()],
	site: "https://leyabierta.es",
	adapter: cloudflare(),
	vite: {
		envDir: "../..",
		// NOTE: the old `entities → …/esm/index.js` alias was removed on the Astro
		// 7 upgrade — it broke subpath imports (`entities/decode` in htmlparser2)
		// under the new rolldown bundler ("Not a directory"). Modern resolution
		// handles the `entities` package exports natively, no alias needed.
	},
	server: { port: Number(process.env.PORT) || 3000 },
	// Stays "static": ~12k law pages remain prebuilt static assets (Workers Free's
	// 20k-file limit). Only routes with `export const prerender = false` (the
	// reform detail page) are rendered on-demand by the Worker — those are not
	// files, so they don't count against the limit.
	output: "static",
	trailingSlash: "always",
	build: {
		concurrency: 4,
	},
});
