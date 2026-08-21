/**
 * Resubmit a sitemap to Search Console to force revalidation.
 *
 * Google caches a sitemap's error state and does not necessarily clear it when
 * the underlying file is fixed: `lastSubmitted` stays frozen at the original
 * submission while `lastDownloaded` advances, and the stale error count keeps
 * being reported. A PUT to the Sitemaps API re-registers the sitemap and makes
 * Google re-evaluate it from scratch.
 *
 * This was needed on 2026-08-21: sitemap-reformas.xml still reported 160
 * "Invalid date" errors from corrupt pipeline years (e.g. 2929) weeks after
 * `isPlausibleReformDate` had filtered them out and the fix was deployed.
 *
 * Usage:
 *   bun run scripts/seo/resubmit-sitemap.ts sitemap-reformas.xml
 *   bun run scripts/seo/resubmit-sitemap.ts            # all child sitemaps
 */

import {
	GSC_SCOPE_WRITE,
	gscSitemaps,
	gscToken,
	SEO_SITE,
	SITE_ORIGIN,
} from "./lib.ts";

async function resubmit(feedpath: string): Promise<void> {
	// Submitting needs the write scope; the rest of the loop is readonly.
	const token = await gscToken(GSC_SCOPE_WRITE);
	const site = encodeURIComponent(SEO_SITE);
	const feed = encodeURIComponent(feedpath);
	const res = await fetch(
		`https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps/${feed}`,
		{ method: "PUT", headers: { Authorization: `Bearer ${token}` } },
	);
	// A successful PUT returns 204 No Content.
	if (!res.ok) {
		throw new Error(
			`resubmit ${feedpath} failed: ${res.status} ${await res.text()}`,
		);
	}
}

const args = process.argv.slice(2);
const targets = args.length
	? args.map((a) => (a.startsWith("http") ? a : `${SITE_ORIGIN}/${a}`))
	: (await gscSitemaps()).filter((s) => !s.isSitemapsIndex).map((s) => s.path);

if (!targets.length) {
	console.error("no sitemaps to resubmit");
	process.exit(1);
}

console.log(`Reenviando ${targets.length} sitemap(s) a ${SEO_SITE}`);
for (const t of targets) {
	await resubmit(t);
	console.log(`  ✓ ${t}`);
}

// Read back so the run reports what Google now holds, not just that the PUT
// succeeded. Error counts are not recomputed instantly — expect the old number
// here and re-check in a day or two.
console.log("\nEstado tras el reenvío:");
for (const s of await gscSitemaps()) {
	console.log(
		`  ${s.path}  errors=${s.errors} warnings=${s.warnings} lastSubmitted=${s.lastSubmitted?.slice(0, 10) ?? "-"}`,
	);
}
