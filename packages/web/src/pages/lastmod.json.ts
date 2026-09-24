/**
 * /lastmod.json — the per-page "own content" hashes and change dates this
 * build computed (see lib/page-lastmod.ts). Published so the NEXT build can
 * download it (build-with-progress.sh) and carry dates forward, and so
 * scripts/seo/indexnow.ts can tell which URLs changed in this deploy.
 *
 * Not a page: `X-Robots-Tag: noindex` in public/_headers.
 */

import type { APIRoute } from "astro";
import { getLastmodState } from "../lib/page-lastmod-build.ts";

export const prerender = true;

export const GET: APIRoute = () =>
	new Response(JSON.stringify(getLastmodState()), {
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
