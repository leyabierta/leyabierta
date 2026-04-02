/**
 * Alert/newsletter endpoints using Resend Audiences.
 *
 * Flow: subscribe (double opt-in) -> confirm -> welcome email.
 * Contacts are stored in Resend Audiences, not local SQLite.
 */

import { Elysia, t } from "elysia";
import { PROFILES } from "../data/profiles.ts";
import {
	getSituationsByIds,
	SITUATION_CATEGORIES,
	SITUATIONS,
} from "../data/situations.ts";
import type { DbService } from "../services/db.ts";
import {
	getAudienceId,
	getResend,
	sendConfirmationEmail,
	sendWelcomeEmail,
	verifyHmac,
} from "../services/email.ts";

// ── Rate limiter (in-memory, per IP, max 3/hour) ───────────────────────

interface RateEntry {
	count: number;
	resetAt: number;
}

const rateLimitMap = new Map<string, RateEntry>();
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isRateLimited(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (!entry || now >= entry.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		return false;
	}

	if (entry.count >= RATE_LIMIT_MAX) {
		return true;
	}

	entry.count++;
	return false;
}

// Periodically clean expired entries (every 10 minutes)
setInterval(
	() => {
		const now = Date.now();
		for (const [ip, entry] of rateLimitMap) {
			if (now >= entry.resetAt) {
				rateLimitMap.delete(ip);
			}
		}
	},
	10 * 60 * 1000,
);

// ── Helper: extract client IP from request ──────────────────────────────

function getClientIp(request: Request): string {
	return (
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
		request.headers.get("cf-connecting-ip") ??
		request.headers.get("x-real-ip") ??
		"unknown"
	);
}

// ── Routes ──────────────────────────────────────────────────────────────

export function alertRoutes(_dbService?: DbService) {
	return new Elysia({ prefix: "/v1" })
		.get("/profiles", () => {
			return {
				data: PROFILES.map((p) => ({
					id: p.id,
					name: p.name,
					description: p.description,
					icon: p.icon,
				})),
			};
		})

		.get("/situations", () => {
			return {
				categories: SITUATION_CATEGORIES,
				situations: SITUATIONS.map((s) => ({
					id: s.id,
					name: s.name,
					category: s.category,
					icon: s.icon,
				})),
			};
		})

		.post(
			"/alerts/subscribe",
			async ({ body, request, set }) => {
				const resend = getResend();
				const audienceId = getAudienceId();

				if (!resend || !audienceId) {
					set.status = 503;
					return {
						error:
							"No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.",
					};
				}

				// Rate limit by IP
				const ip = getClientIp(request);
				if (isRateLimited(ip)) {
					// Return generic 200 to avoid leaking rate-limit info
					return {
						ok: true,
						message:
							"Si tu email es válido, recibirás un enlace de confirmación",
					};
				}

				// Validate situationIds
				const validSituations = getSituationsByIds(body.situationIds);
				if (validSituations.length === 0) {
					set.status = 400;
					return { error: "Debes seleccionar al menos una situación válida" };
				}

				const email = body.email;
				const jurisdiction = body.jurisdiction ?? "es";

				try {
					await resend.contacts.create({
						audienceId,
						email,
						unsubscribed: true,
						properties: {
							situation_ids: JSON.stringify(body.situationIds),
							jurisdiction,
							consent_ts: new Date().toISOString(),
							consent_ip: ip,
						},
					});
				} catch (err: unknown) {
					// Duplicate contact — silently continue (send confirmation anyway
					// since they may not have confirmed the first time)
					const isDuplicate =
						err instanceof Error &&
						(err.message?.includes("already exists") ||
							err.message?.includes("duplicate"));
					if (!isDuplicate) {
						console.error("[alerts] Resend contacts.create failed:", err);
						// Still return generic 200 to avoid email enumeration
					}
				}

				// Send confirmation email (best effort — always return generic 200)
				const situationNames = validSituations.map((s) => s.name);
				await sendConfirmationEmail(email, situationNames).catch((err) => {
					console.error("[alerts] Failed to send confirmation email:", err);
				});

				return {
					ok: true,
					message: "Si tu email es válido, recibirás un enlace de confirmación",
				};
			},
			{
				body: t.Object({
					email: t.String({ format: "email" }),
					situationIds: t.Array(t.String(), { minItems: 1 }),
					jurisdiction: t.Optional(t.String()),
				}),
			},
		)

		.get(
			"/alerts/confirm",
			async ({ query, set }) => {
				const { email, code } = query;

				if (!email || !code) {
					set.status = 400;
					return { error: "Enlace no válido o expirado" };
				}

				const valid = await verifyHmac(email, code);
				if (!valid) {
					set.status = 400;
					return { error: "Enlace no válido o expirado" };
				}

				const resend = getResend();
				const audienceId = getAudienceId();

				if (!resend || !audienceId) {
					set.status = 503;
					return {
						error:
							"No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.",
					};
				}

				try {
					// Update the contact to mark as subscribed
					await resend.contacts.update({
						audienceId,
						id: email,
						unsubscribed: false,
					});
				} catch (err) {
					console.error("[alerts] Resend contacts.update failed:", err);
					set.status = 503;
					return {
						error:
							"No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.",
					};
				}

				// Send welcome email (best effort)
				await sendWelcomeEmail(email).catch((err) => {
					console.error("[alerts] Failed to send welcome email:", err);
				});

				return { success: true, message: "Suscripción confirmada" };
			},
			{
				query: t.Object({
					email: t.String(),
					code: t.String(),
				}),
			},
		)

		.get(
			"/alerts/unsubscribe",
			async ({ query, set }) => {
				const { email, code } = query;

				if (!email || !code) {
					set.status = 400;
					return { error: "Enlace no válido o expirado" };
				}

				const valid = await verifyHmac(email, code);
				if (!valid) {
					set.status = 400;
					return { error: "Enlace no válido o expirado" };
				}

				const resend = getResend();
				const audienceId = getAudienceId();

				if (!resend || !audienceId) {
					set.status = 503;
					return {
						error:
							"No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.",
					};
				}

				try {
					await resend.contacts.remove({
						audienceId,
						email,
					});
				} catch (err) {
					console.error("[alerts] Resend contacts.remove failed:", err);
					// If the contact doesn't exist, that's fine — treat as success
				}

				return { success: true };
			},
			{
				query: t.Object({
					email: t.String(),
					code: t.String(),
				}),
			},
		);
}
