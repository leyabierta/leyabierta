import { defineConfig } from "astro/config";
import node from "@astrojs/node";

export default defineConfig({
	server: { port: 4321 },
	output: "server",
	adapter: node({ mode: "standalone" }),
});
