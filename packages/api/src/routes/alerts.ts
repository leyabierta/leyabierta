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
	generateHmac,
	getAudienceId,
	getResend,
	sendConfirmationEmail,
	sendFollowConfirmationEmail,
	sendWelcomeEmail,
	verifyHmac,
} from "../services/email.ts";

const MAX_MATERIAS = 60;

// ── Rate limiter (in-memory, per IP, max 3/hour) ───────────────────────

interface RateEntry {
	count: number;
	resetAt: number;
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function createRateLimiter(maxRequests: number) {
	const map = new Map<string, RateEntry>();

	// Periodically clean expired entries (every 10 minutes)
	setInterval(
		() => {
			const now = Date.now();
			for (const [ip, entry] of map) {
				if (now >= entry.resetAt) map.delete(ip);
			}
		},
		10 * 60 * 1000,
	);

	return {
		isLimited(ip: string): boolean {
			const now = Date.now();
			const entry = map.get(ip);

			if (!entry || now >= entry.resetAt) {
				map.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
				return false;
			}

			if (entry.count >= maxRequests) return true;

			entry.count++;
			return false;
		},
	};
}

const postLimiter = createRateLimiter(3); // 3/hour for POST (subscribe, follow)
const getLimiter = createRateLimiter(10); // 10/hour for GET (confirm, unsubscribe)

function isRateLimited(ip: string): boolean {
	return postLimiter.isLimited(ip);
}

function isGetRateLimited(ip: string): boolean {
	return getLimiter.isLimited(ip);
}

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

				// Accept materias (new) or situationIds (legacy)
				const materias = body.materias ?? [];
				const legacySituations = body.situationIds
					? getSituationsByIds(body.situationIds)
					: [];

				if (materias.length === 0 && legacySituations.length === 0) {
					set.status = 400;
					return {
						error: "Debes seleccionar al menos un tema o situación válida",
					};
				}

				if (materias.length > MAX_MATERIAS) {
					set.status = 400;
					return {
						error: `Máximo ${MAX_MATERIAS} temas permitidos`,
					};
				}

				const email = body.email;
				const jurisdiction = body.jurisdiction ?? "es";

				try {
					await resend.contacts.create({
						audienceId,
						email,
						unsubscribed: true,
						properties: {
							...(materias.length > 0
								? { materias: JSON.stringify(materias) }
								: {
										situation_ids: JSON.stringify(body.situationIds),
									}),
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
				const topicCount =
					materias.length > 0 ? materias.length : legacySituations.length;
				await sendConfirmationEmail(email, topicCount).catch((err) => {
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
					situationIds: t.Optional(t.Array(t.String())),
					materias: t.Optional(t.Array(t.String())),
					jurisdiction: t.Optional(t.String()),
				}),
			},
		)

		.get(
			"/alerts/confirm",
			async ({ query, set, request }) => {
				const ip = getClientIp(request);
				if (isGetRateLimited(ip)) {
					set.status = 429;
					return { error: "Demasiados intentos. Inténtalo más tarde." };
				}

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

		.post(
			"/alerts/follow",
			async ({ body, request, set }) => {
				const dbService = _dbService;
				if (!dbService) {
					set.status = 503;
					return {
						error:
							"No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.",
					};
				}

				// Rate limit by IP
				const ip = getClientIp(request);
				if (isRateLimited(ip)) {
					return {
						ok: true,
						message:
							"Si tu email es válido, recibirás un enlace de confirmación",
					};
				}

				const { email, normId } = body;

				// Validate norm exists
				const norm = dbService.getLaw(normId);
				if (!norm) {
					set.status = 400;
					return { error: "No se encontró la ley indicada" };
				}

				// Generate a unique token for confirmation
				const token = await generateHmac(`${email}:follow:${normId}`);

				// Insert or update (upsert) — if already exists and confirmed, skip
				try {
					dbService.upsertNormFollow(email, normId, token);
				} catch (err) {
					console.error("[alerts] Failed to insert norm follow:", err);
					set.status = 500;
					return {
						error:
							"No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.",
					};
				}

				// Send confirmation email (best effort)
				await sendFollowConfirmationEmail(
					email,
					norm.title,
					normId,
					token,
				).catch((err) => {
					console.error(
						"[alerts] Failed to send follow confirmation email:",
						err,
					);
				});

				return {
					ok: true,
					message: "Si tu email es válido, recibirás un enlace de confirmación",
				};
			},
			{
				body: t.Object({
					email: t.String({ format: "email" }),
					normId: t.String({ minLength: 1 }),
				}),
			},
		)

		.get(
			"/alerts/follow/confirm",
			async ({ query, set, request }) => {
				const ip = getClientIp(request);
				if (isGetRateLimited(ip)) {
					set.status = 429;
					return { error: "Demasiados intentos. Inténtalo más tarde." };
				}

				const { token } = query;

				if (!token) {
					set.status = 400;
					return { error: "Enlace no válido o expirado" };
				}

				const dbService = _dbService;
				if (!dbService) {
					set.status = 503;
					return {
						error:
							"No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.",
					};
				}

				const confirmed = dbService.confirmNormFollow(token);
				if (!confirmed) {
					set.status = 400;
					return { error: "Enlace no válido o expirado" };
				}

				return { success: true, message: "Suscripción confirmada" };
			},
			{
				query: t.Object({
					token: t.String(),
				}),
			},
		)

		.get(
			"/alerts/unsubscribe",
			async ({ query, set, request }) => {
				const ip = getClientIp(request);
				if (isGetRateLimited(ip)) {
					set.status = 429;
					return { error: "Demasiados intentos. Inténtalo más tarde." };
				}

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

				// GDPR: also remove norm follow records for this email
				if (_dbService) {
					try {
						_dbService.deleteNormFollowsByEmail(email);
					} catch (err) {
						console.error("[alerts] Failed to delete norm_follows:", err);
					}
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
