import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
	integrations: [react()],
	site: "https://leyabierta.es",
	vite: {
		envDir: "../..",
		// NOTE: the old `entities → …/esm/index.js` alias was removed on the Astro
		// 7 upgrade — it broke subpath imports (`entities/decode` in htmlparser2)
		// under the new rolldown bundler ("Not a directory"). Modern resolution
		// handles the `entities` package exports natively, no alias needed.
	},
	server: { port: Number(process.env.PORT) || 3000 },
	// Pure static build — no adapter. All ~12k law pages plus every other route
	// are prebuilt to dist/ at `astro build` time. The reforma detail page
	// (/cambios/reforma/) is a static client-rendered shell here; a standalone
	// Cloudflare Worker in front (src/worker/index.ts) intercepts requests to
	// that path with `?id&date` and injects server-rendered content into the
	// shell before serving it, without needing an Astro SSR adapter (whose
	// workerd prerenderer can't do fs reads at render time — that's why it
	// only built 81/12k pages when we tried it).
	output: "static",
	trailingSlash: "always",
	build: {
		concurrency: 4,
	},
});
