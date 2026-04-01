import { defineConfig } from "astro/config";

export default defineConfig({
	vite: { envDir: "../.." },
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
