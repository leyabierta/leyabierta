import { resolve } from "node:path";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://leyabierta.es",
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
