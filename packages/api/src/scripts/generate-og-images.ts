import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

// --- CLI flags ---
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : 0;

// --- Paths ---
const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const DB_PATH = process.env.DB_PATH || join(ROOT, "data", "leyabierta.db");
const OG_DIR = process.env.OG_IMAGES_DIR || join(ROOT, "og-images");

// --- Font ---
async function loadFont(): Promise<ArrayBuffer> {
	// Try local bundled font first, fall back to Google Fonts
	const localPath = join(
		ROOT,
		"packages",
		"web",
		"public",
		"fonts",
		"Inter-Bold.ttf",
	);
	if (existsSync(localPath)) {
		console.log(`Using local font: ${localPath}`);
		return Bun.file(localPath).arrayBuffer();
	}
	// Inter 700 (bold) from Google Fonts — used for titles
	const url =
		"https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYMZg.ttf";
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(
			`Failed to fetch Inter font (${res.status}). For offline use, place Inter-Bold.ttf in packages/web/public/fonts/`,
		);
	}
	return res.arrayBuffer();
}

// --- Helpers ---
function truncate(text: string, maxLen: number): string {
	if (!text || text.length <= maxLen) return text || "";
	// Cut at last space before limit to avoid mid-word truncation
	const cut = text.lastIndexOf(" ", maxLen - 1);
	const end = cut > maxLen * 0.5 ? cut : maxLen - 1;
	return `${text.slice(0, end)}\u2026`;
}

function extractYear(date: string | null): string {
	if (!date) return "";
	return date.slice(0, 4);
}

function statusLabel(status: string | null): string {
	if (!status) return "";
	if (status === "vigente") return "Vigente";
	if (status === "derogado" || status === "derogada") return "Derogada";
	return status.charAt(0).toUpperCase() + status.slice(1);
}

// --- OG image generation ---
interface Law {
	id: string;
	title: string;
	citizen_summary: string | null;
	rank: string | null;
	status: string | null;
	published_at: string | null;
	updated_at: string | null;
	reform_count: number;
}

function loadLogo(): string {
	const logoPath = join(ROOT, "packages", "web", "public", "logo-full.png");
	if (!existsSync(logoPath)) return "";
	const buf = readFileSync(logoPath);
	return `data:image/png;base64,${buf.toString("base64")}`;
}

function buildMarkup(law: Law, logoDataUri: string): Record<string, unknown> {
	const title = truncate(law.title, 90);
	const summary = truncate(law.citizen_summary ?? "", 180);
	const year = extractYear(law.published_at);
	const status = statusLabel(law.status);
	const reformText =
		law.reform_count > 0 ? `Reformada ${law.reform_count} veces` : "";

	// Bottom info pieces
	const bottomParts: string[] = [];
	if (status) bottomParts.push(status);
	if (reformText) bottomParts.push(reformText);
	if (year) bottomParts.push(`Desde ${year}`);
	const bottomText = bottomParts.join("  \u00b7  ");

	return {
		type: "div",
		props: {
			style: {
				display: "flex",
				flexDirection: "column",
				width: "100%",
				height: "100%",
				backgroundColor: "#FFFFFF",
			},
			children: [
				// Top accent bar
				{
					type: "div",
					props: {
						style: {
							width: "100%",
							height: "6px",
							backgroundColor: "#1A365D",
						},
					},
				},
				// All content in one block — everything visible in top 2/3
				{
					type: "div",
					props: {
						style: {
							display: "flex",
							flexDirection: "column",
							padding: "64px 64px",
						},
						children: [
							// Logo
							...(logoDataUri
								? [
										{
											type: "img",
											props: {
												src: logoDataUri,
												style: {
													height: "32px",
													marginBottom: "28px",
												},
											},
										},
									]
								: []),
							// Title
							{
								type: "div",
								props: {
									style: {
										fontSize: "42px",
										fontWeight: 700,
										color: "#1A365D",
										lineHeight: 1.2,
									},
									children: title,
								},
							},
							// Summary
							...(summary
								? [
										{
											type: "div",
											props: {
												style: {
													fontSize: "24px",
													color: "#475569",
													marginTop: "24px",
													lineHeight: 1.45,
												},
												children: summary,
											},
										},
									]
								: []),
							// Metadata line
							{
								type: "div",
								props: {
									style: {
										fontSize: "18px",
										color: "#94A3B8",
										marginTop: "28px",
									},
									children: bottomText,
								},
							},
						],
					},
				},
			],
		},
	};
}

async function generateImage(
	law: Law,
	fontData: ArrayBuffer,
	logoDataUri: string,
): Promise<Buffer> {
	const markup = buildMarkup(law, logoDataUri);
	// biome-ignore lint/suspicious/noExplicitAny: satori expects ReactNode but buildMarkup returns Record
	const svg = await satori(markup as any, {
		width: 1200,
		height: 630,
		fonts: [{ name: "Inter", data: fontData, style: "normal" as const }],
	});
	const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
	return resvg.render().asPng();
}

// --- Main ---
async function main() {
	if (!existsSync(DB_PATH)) {
		console.error(`Database not found: ${DB_PATH}`);
		process.exit(1);
	}

	console.log("Loading assets...");
	const fontData = await loadFont();
	const logoDataUri = loadLogo();

	const db = new Database(DB_PATH, { readonly: true });

	// Generate for ALL norms — images are served from KonarServer, not Cloudflare Pages,
	// so there's no file count limit. ~525MB total for 12K images.
	const query = `
SELECT n.id, n.title, n.citizen_summary, n.rank, n.status,
  n.published_at, n.updated_at,
  (SELECT COUNT(*) FROM reforms r WHERE r.norm_id = n.id) as reform_count
FROM norms n
ORDER BY reform_count DESC
`;

	const laws = db.query(query).all() as Law[];
	const total = limit > 0 ? Math.min(limit, laws.length) : laws.length;
	const subset = laws.slice(0, total);

	console.log(`Found ${laws.length} qualifying laws, processing ${total}`);

	if (dryRun) {
		console.log("Dry run - no images generated");
		db.close();
		return;
	}

	mkdirSync(OG_DIR, { recursive: true });

	let generated = 0;
	let skipped = 0;
	let failed = 0;

	for (const law of subset) {
		const outPath = join(OG_DIR, `${law.id}.png`);

		if (!force && existsSync(outPath)) {
			skipped++;
			continue;
		}

		try {
			const png = await generateImage(law, fontData, logoDataUri);
			writeFileSync(outPath, png);
			generated++;
			console.log(`Generated ${generated}/${total} - ${law.id}`);
		} catch (err) {
			failed++;
			console.error(
				`Failed ${law.id}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	if (skipped > 0) {
		console.log(
			`Skipped ${skipped} existing images (use --force to regenerate)`,
		);
	}
	if (failed > 0) {
		console.error(`Failed: ${failed} images`);
	}
	console.log(
		`Done. ${generated} generated, ${skipped} skipped, ${failed} failed in ${OG_DIR}`,
	);

	db.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
