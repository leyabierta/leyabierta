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
import { createRateLimiter, getClientIp } from "../services/rate-limiter.ts";

const MAX_MATERIAS = 60;

// Per-email unsubscribe token. Deterministic per email so all subscriptions
// share one cookie value for the user. Used by /alerts/me and as the
// `lb_token` cookie set after confirmation.
async function unsubTokenForEmail(email: string): Promise<string> {
	return generateHmac(`${email}:unsub`);
}

// Mirrors a set of (type, scope) pairs into the unified subscriptions table.
// Idempotent: upsert preserves prior `confirmed=1` state. Best effort — never
// throws into the request handler.
async function mirrorToSubscriptions(
	dbService: DbService | undefined,
	email: string,
	items: Array<{
		type: "materia" | "jurisdiccion" | "norma";
		scope: string;
	}>,
	confirmToken: string,
	confirmed: boolean,
): Promise<void> {
	if (!dbService || items.length === 0) return;
	try {
		const unsubToken = await unsubTokenForEmail(email);
		for (const item of items) {
			dbService.upsertSubscription({
				email,
				type: item.type,
				scope: item.scope,
				confirmToken,
				unsubToken,
				confirmed,
			});
		}
	} catch (err) {
		console.error("[alerts] Failed to mirror to subscriptions:", err);
	}
}

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const postLimiter = createRateLimiter(3, RATE_LIMIT_WINDOW_MS); // 3/hour for POST
const getLimiter = createRateLimiter(60, RATE_LIMIT_WINDOW_MS); // 60/hour for GET (one /alerts/me lookup per leyes/[id] visit)

function isRateLimited(ip: string): boolean {
	return postLimiter.isLimited(ip);
}

function isGetRateLimited(ip: string): boolean {
	return getLimiter.isLimited(ip);
}

// ── Routes ──────────────────────────────────────────────────────────────

export function alertRoutes(_dbService?: DbService) {
	return (
		new Elysia({ prefix: "/v1" })
			.get(
				"/profiles",
				() => {
					return {
						data: PROFILES.map((p) => ({
							id: p.id,
							name: p.name,
							description: p.description,
							icon: p.icon,
						})),
					};
				},
				{
					detail: {
						summary: "List subscriber profiles",
						description:
							"Returns available subscriber profiles for the alert wizard.",
						tags: ["Alertas"],
					},
				},
			)

			.get(
				"/situations",
				() => {
					return {
						categories: SITUATION_CATEGORIES,
						situations: SITUATIONS.map((s) => ({
							id: s.id,
							name: s.name,
							category: s.category,
							icon: s.icon,
						})),
					};
				},
				{
					detail: {
						summary: "List life situations",
						description:
							"Returns available life situation categories and options for the alert wizard.",
						tags: ["Alertas"],
					},
				},
			)

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

					// Mirror to unified subscriptions table. Same confirm token as the
					// email link (HMAC of email) so a single click confirms every row.
					const confirmToken = await generateHmac(email);
					const items: Array<{
						type: "materia" | "jurisdiccion";
						scope: string;
					}> = [
						...materias.map((m: string) => ({
							type: "materia" as const,
							scope: m,
						})),
						{ type: "jurisdiccion" as const, scope: jurisdiction },
					];
					await mirrorToSubscriptions(
						_dbService,
						email,
						items,
						confirmToken,
						false,
					);

					// Send confirmation email (best effort — always return generic 200)
					const topicCount =
						materias.length > 0 ? materias.length : legacySituations.length;
					await sendConfirmationEmail(email, topicCount).catch((err) => {
						console.error("[alerts] Failed to send confirmation email:", err);
					});

					return {
						ok: true,
						message:
							"Si tu email es válido, recibirás un enlace de confirmación",
					};
				},
				{
					body: t.Object({
						email: t.String({ format: "email" }),
						situationIds: t.Optional(t.Array(t.String())),
						materias: t.Optional(t.Array(t.String())),
						jurisdiction: t.Optional(t.String()),
					}),
					detail: {
						summary: "Subscribe to alerts",
						description:
							"Subscribe an email to legislative reform alerts. Triggers double opt-in confirmation email.",
						tags: ["Alertas"],
					},
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

					// Confirm all subscription rows for this email in the unified table.
					if (_dbService) {
						try {
							_dbService.confirmSubscriptionsByToken(code);
						} catch (err) {
							console.error("[alerts] Failed to confirm subscriptions:", err);
						}
					}

					// Send welcome email (best effort)
					await sendWelcomeEmail(email).catch((err) => {
						console.error("[alerts] Failed to send welcome email:", err);
					});

					// Cookie value the frontend will set on the confirmation page so
					// returning users are recognized without typing their email again.
					const lbToken = await unsubTokenForEmail(email);
					return {
						success: true,
						message: "Suscripción confirmada",
						token: lbToken,
					};
				},
				{
					query: t.Object({
						email: t.String(),
						code: t.String(),
					}),
					detail: {
						summary: "Confirm alert subscription",
						description:
							"Confirms a subscription via HMAC-signed email link. Marks contact as subscribed in Resend and in subscriptions table. Returns the per-email cookie token.",
						tags: ["Alertas"],
					},
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

					// Mirror into unified subscriptions table.
					await mirrorToSubscriptions(
						dbService,
						email,
						[{ type: "norma", scope: normId }],
						token,
						false,
					);

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
						message:
							"Si tu email es válido, recibirás un enlace de confirmación",
					};
				},
				{
					body: t.Object({
						email: t.String({ format: "email" }),
						normId: t.String({ minLength: 1 }),
					}),
					detail: {
						summary: "Follow a specific law",
						description:
							"Subscribe to notifications for a specific law. Sends a confirmation email.",
						tags: ["Alertas"],
					},
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

					// Mirror confirmation into unified subscriptions table. Look up the
					// email so we can return its cookie token to the confirmation page.
					let lbToken: string | undefined;
					try {
						const row = dbService.getSubscriptionByConfirmToken(token);
						dbService.confirmSubscriptionsByToken(token);
						if (row?.email) {
							lbToken = await unsubTokenForEmail(row.email);
						}
					} catch (err) {
						console.error(
							"[alerts] Failed to confirm subscription mirror:",
							err,
						);
					}

					return {
						success: true,
						message: "Suscripción confirmada",
						token: lbToken,
					};
				},
				{
					query: t.Object({
						token: t.String(),
					}),
					detail: {
						summary: "Confirm law follow",
						description:
							"Confirms a law-follow subscription via token from the confirmation email. Mirrors confirmation in unified subscriptions table.",
						tags: ["Alertas"],
					},
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

					// GDPR: also remove norm follow records and unified subscriptions
					if (_dbService) {
						try {
							_dbService.deleteNormFollowsByEmail(email);
						} catch (err) {
							console.error("[alerts] Failed to delete norm_follows:", err);
						}
						try {
							_dbService.deleteSubscriptionsByEmail(email);
						} catch (err) {
							console.error("[alerts] Failed to delete subscriptions:", err);
						}
					}

					return { success: true };
				},
				{
					query: t.Object({
						email: t.String(),
						code: t.String(),
					}),
					detail: {
						summary: "Unsubscribe from alerts",
						description:
							"Unsubscribes an email from all alerts. Removes contact from Resend and deletes law-follow records and unified subscriptions (GDPR).",
						tags: ["Alertas"],
					},
				},
			)

			// ── /v1/alerts/me ─────────────────────────────────────────────────
			// Reads the user's confirmed subscriptions by unsubscribe token (cookie).
			// No email leak: caller must already possess the per-email token.

			.get(
				"/alerts/me",
				({ query, set, request }) => {
					const ip = getClientIp(request);
					if (isGetRateLimited(ip)) {
						set.status = 429;
						return { error: "Demasiados intentos. Inténtalo más tarde." };
					}

					const dbService = _dbService;
					if (!dbService) {
						set.status = 503;
						return { error: "Servicio temporalmente no disponible." };
					}

					const rows = dbService.getSubscriptionsByUnsubToken(query.token);
					if (rows.length === 0) {
						return { email: null, items: [] };
					}

					return {
						email: rows[0]?.email ?? null,
						items: rows.map((r) => ({
							id: r.id,
							type: r.type,
							scope: r.scope,
							confirmed: r.confirmed === 1,
						})),
					};
				},
				{
					query: t.Object({
						token: t.String({ minLength: 16 }),
					}),
					detail: {
						summary: "List my subscriptions (cookie-authenticated)",
						description:
							"Returns the subscriptions belonging to the email associated with the given unsub token. The token is set as cookie `lb_token` on confirmation.",
						tags: ["Alertas"],
					},
				},
			)

			.delete(
				"/alerts/me",
				({ query, set, request }) => {
					const ip = getClientIp(request);
					if (isRateLimited(ip)) {
						set.status = 429;
						return { error: "Demasiados intentos. Inténtalo más tarde." };
					}

					const dbService = _dbService;
					if (!dbService) {
						set.status = 503;
						return { error: "Servicio temporalmente no disponible." };
					}

					const id = Number.parseInt(query.id, 10);
					if (!Number.isFinite(id) || id <= 0) {
						set.status = 400;
						return { error: "Identificador inválido." };
					}

					const ok = dbService.deleteSubscription(id, query.token);
					if (!ok) {
						set.status = 404;
						return { error: "Suscripción no encontrada." };
					}

					return { success: true };
				},
				{
					query: t.Object({
						id: t.String({ minLength: 1 }),
						token: t.String({ minLength: 16 }),
					}),
					detail: {
						summary: "Delete a single subscription",
						description:
							"Removes one subscription row by id, gated by the per-email unsub token (cookie).",
						tags: ["Alertas"],
					},
				},
			)
	);
}
