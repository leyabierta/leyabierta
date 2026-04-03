/**
 * Email service using Resend for newsletter delivery.
 */

import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM_EMAIL =
	process.env.FROM_EMAIL ?? "Ley Abierta <alertas@leyabierta.es>";
const SITE_URL = process.env.SITE_URL ?? "https://leyabierta.es";
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID ?? "";
const ALERTS_SECRET =
	process.env.ALERTS_SECRET ?? `derived-key-${RESEND_API_KEY}`;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

if (!RESEND_AUDIENCE_ID) {
	console.warn(
		"[email] RESEND_AUDIENCE_ID not set — subscribe endpoints will return 503",
	);
}

export function getResend(): Resend | null {
	return resend;
}

export function getAudienceId(): string {
	return RESEND_AUDIENCE_ID;
}

export function getSiteUrl(): string {
	return SITE_URL;
}

// ── HMAC helpers ────────────────────────────────────────────────────────

export async function generateHmac(email: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(ALERTS_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(email),
	);
	return Buffer.from(signature).toString("hex");
}

export async function verifyHmac(
	email: string,
	code: string,
): Promise<boolean> {
	const expected = await generateHmac(email);
	// Constant-time comparison
	if (expected.length !== code.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
	}
	return diff === 0;
}

// ── Unsubscribe helpers ─────────────────────────────────────────────────

export async function buildUnsubscribeUrl(email: string): Promise<string> {
	const hmac = await generateHmac(email);
	return `${SITE_URL}/alertas/cancelar?email=${encodeURIComponent(email)}&code=${hmac}`;
}

function buildListUnsubscribeHeader(unsubUrl: string): string {
	return `<${unsubUrl}>`;
}

// ── Transactional emails ────────────────────────────────────────────────

export async function sendConfirmationEmail(
	email: string,
	topicCount: number,
): Promise<boolean> {
	const hmac = await generateHmac(email);
	const confirmUrl = `${SITE_URL}/alertas/confirmar?email=${encodeURIComponent(email)}&code=${hmac}`;
	const cancelUrl = await buildUnsubscribeUrl(email);

	const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0b1120;">
  <h2 style="font-family: Georgia, serif; color: #1a365d; margin-bottom: 8px;">Confirma tu suscripción</h2>
  <p style="color: #4a6078; line-height: 1.6;">
    Has solicitado recibir alertas legislativas en Ley Abierta. Hemos configurado seguimiento de <strong>${topicCount} tema${topicCount === 1 ? "" : "s"} legislativo${topicCount === 1 ? "" : "s"}</strong> para ti.
  </p>
  <p style="color: #4a6078; line-height: 1.6;">
    Te avisaremos cuando se publiquen cambios que te afecten. Oirás poco de nosotros, pero cuando oigas será importante.
  </p>
  <p style="margin: 24px 0;">
    <a href="${confirmUrl}" style="display: inline-block; padding: 12px 24px; background: #1a365d; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Confirmar suscripción
    </a>
  </p>
  <p style="color: #6b8299; font-size: 14px; line-height: 1.5;">
    Si no has sido tú, puedes ignorar este email o <a href="${cancelUrl}" style="color: #2b5797;">cancelar la suscripción</a>.
  </p>
  <hr style="border: none; border-top: 1px solid #e8ecf0; margin: 24px 0;" />
  <p style="color: #6b8299; font-size: 12px;">
    Ley Abierta — Legislación española consolidada, accesible para todos.
  </p>
</body>
</html>`.trim();

	if (!resend) {
		console.log(`[email-dry-run] Confirmation to ${email}: ${confirmUrl}`);
		return true;
	}

	try {
		const unsubHeader = buildListUnsubscribeHeader(cancelUrl);
		await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject: "Confirma tu suscripción — Ley Abierta",
			html,
			headers: {
				"List-Unsubscribe": unsubHeader,
			},
		});
		return true;
	} catch (err) {
		console.error("[email] Failed to send confirmation:", err);
		return false;
	}
}

export async function sendFollowConfirmationEmail(
	email: string,
	normTitle: string,
	normId: string,
	token: string,
): Promise<boolean> {
	const confirmUrl = `${SITE_URL}/alertas/seguir/confirmar?token=${encodeURIComponent(token)}`;
	const normUrl = `${SITE_URL}/laws/${normId}`;

	const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0b1120;">
  <h2 style="font-family: Georgia, serif; color: #1a365d; margin-bottom: 8px;">Confirma que quieres seguir esta ley</h2>
  <p style="color: #4a6078; line-height: 1.6;">
    Has solicitado recibir notificaciones cuando cambie:
  </p>
  <p style="color: #1a365d; font-weight: 600; line-height: 1.6;">
    <a href="${normUrl}" style="color: #2b5797;">${escapeHtml(normTitle)}</a>
  </p>
  <p style="margin: 24px 0;">
    <a href="${confirmUrl}" style="display: inline-block; padding: 12px 24px; background: #1a365d; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Confirmar suscripción
    </a>
  </p>
  <p style="color: #6b8299; font-size: 14px; line-height: 1.5;">
    Si no has sido tú, puedes ignorar este email.
  </p>
  <hr style="border: none; border-top: 1px solid #e8ecf0; margin: 24px 0;" />
  <p style="color: #6b8299; font-size: 12px;">
    Ley Abierta — Legislación española consolidada, accesible para todos.
  </p>
</body>
</html>`.trim();

	if (!resend) {
		console.log(
			`[email-dry-run] Follow confirmation to ${email} for ${normId}: ${confirmUrl}`,
		);
		return true;
	}

	try {
		await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject: `Confirma que quieres seguir: ${normTitle} — Ley Abierta`,
			html,
		});
		return true;
	} catch (err) {
		console.error("[email] Failed to send follow confirmation:", err);
		return false;
	}
}

export async function sendWelcomeEmail(email: string): Promise<boolean> {
	const cancelUrl = await buildUnsubscribeUrl(email);

	const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0b1120;">
  <h2 style="font-family: Georgia, serif; color: #1a365d; margin-bottom: 8px;">Bienvenido/a a Ley Abierta</h2>
  <p style="color: #4a6078; line-height: 1.6;">
    Tu suscripción ha sido confirmada. A partir de ahora recibirás alertas cuando se publiquen cambios legislativos que te afecten.
  </p>
  <p style="color: #4a6078; line-height: 1.6;">
    Puedes modificar tus preferencias en cualquier momento desde <a href="${SITE_URL}/mi-situacion" style="color: #2b5797;">tu perfil</a>, o cancelar la suscripción con el enlace de abajo.
  </p>
  <hr style="border: none; border-top: 1px solid #e8ecf0; margin: 24px 0;" />
  <p style="color: #6b8299; font-size: 12px;">
    Ley Abierta — Legislación española consolidada, accesible para todos.
    <a href="${cancelUrl}" style="color: #2b5797;">Cancelar suscripción</a>
  </p>
</body>
</html>`.trim();

	if (!resend) {
		console.log(`[email-dry-run] Welcome to ${email}`);
		return true;
	}

	try {
		const unsubHeader = buildListUnsubscribeHeader(cancelUrl);
		await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject: "Bienvenido/a a Ley Abierta",
			html,
			headers: {
				"List-Unsubscribe": unsubHeader,
			},
		});
		return true;
	} catch (err) {
		console.error("[email] Failed to send welcome:", err);
		return false;
	}
}

export async function sendNotificationEmail(
	email: string,
	subject: string,
	html: string,
): Promise<boolean> {
	if (!resend) {
		console.log(`[email-dry-run] Notification to ${email}: ${subject}`);
		return true;
	}

	try {
		const cancelUrl = await buildUnsubscribeUrl(email);
		const unsubHeader = buildListUnsubscribeHeader(cancelUrl);
		await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject,
			html,
			headers: {
				"List-Unsubscribe": unsubHeader,
			},
		});
		return true;
	} catch (err) {
		console.error(`[email] Failed to send notification to ${email}:`, err);
		return false;
	}
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
