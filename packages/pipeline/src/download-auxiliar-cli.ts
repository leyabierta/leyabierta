/**
 * Download all BOE auxiliary data (reference tables).
 *
 * Usage: bun run packages/pipeline/src/download-auxiliar-cli.ts
 */

const BASE = "https://www.boe.es/datosabiertos/api";
const OUT_DIR = "./data/auxiliar";

const ENDPOINTS = [
	"datos-auxiliares/materias",
	"datos-auxiliares/departamentos",
	"datos-auxiliares/rangos",
	"datos-auxiliares/ambitos",
	"datos-auxiliares/estados-consolidacion",
	"datos-auxiliares/relaciones-anteriores",
	"datos-auxiliares/relaciones-posteriores",
] as const;

async function main() {
	await Bun.write(`${OUT_DIR}/.gitkeep`, "");

	for (const endpoint of ENDPOINTS) {
		const name = endpoint.split("/")[1]!;
		const url = `${BASE}/${endpoint}`;
		console.log(`Downloading ${name}...`);

		try {
			const res = await fetch(url, {
				headers: { Accept: "application/json" },
			});
			if (!res.ok) {
				console.error(`  ERROR: ${res.status}`);
				continue;
			}
			const json = await res.json();
			const path = `${OUT_DIR}/${name}.json`;
			await Bun.write(path, JSON.stringify(json, null, 2));

			const count = Array.isArray(json.data) ? json.data.length : "?";
			console.log(`  OK: ${count} items → ${path}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`  ERROR: ${msg}`);
		}
	}

	console.log("\nDone.");
}

main();
