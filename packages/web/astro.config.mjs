import { defineConfig } from "astro/config";

export default defineConfig({
	output: "static",
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
