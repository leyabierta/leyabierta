import { resolve } from "node:path";
import { defineConfig } from "astro/config";

export default defineConfig({
	vite: {
		envDir: "../..",
		resolve: {
			alias: {
				entities: resolve("../../node_modules/entities/lib/esm/index.js"),
			},
		},
	},
	server: { port: Number(process.env.PORT) || 3000 },
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
