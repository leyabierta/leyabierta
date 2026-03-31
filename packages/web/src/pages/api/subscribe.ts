/**
 * Proxy endpoint for newsletter subscription.
 * Forwards to Elysia API to avoid CORS issues from client-side fetch.
 */

import type { APIRoute } from "astro";

const API_BASE = import.meta.env.API_URL ?? "http://localhost:3000";

export const POST: APIRoute = async ({ request }) => {
	const body = await request.json();

	const res = await fetch(`${API_BASE}/v1/alerts/subscribe`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	const data = await res.json();

	return new Response(JSON.stringify(data), {
		status: res.status,
		headers: { "Content-Type": "application/json" },
	});
};
