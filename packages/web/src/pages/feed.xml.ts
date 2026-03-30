/**
 * RSS feed proxy — fetches from API and returns XML.
 */

import type { APIRoute } from "astro";

const API_BASE = import.meta.env.API_URL ?? "http://localhost:3000";

export const GET: APIRoute = async () => {
	const res = await fetch(`${API_BASE}/v1/feed.xml`);
	const xml = await res.text();
	return new Response(xml, {
		headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
	});
};
