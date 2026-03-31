/**
 * Email service using Resend for newsletter delivery.
 */

import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM_EMAIL =
	process.env.FROM_EMAIL ?? "Ley Abierta <alertas@leyabierta.es>";
const SITE_URL = process.env.SITE_URL ?? "https://leyabierta.es";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

export function getSiteUrl(): string {
	return SITE_URL;
}

export async function sendConfirmationEmail(
	email: string,
	token: string,
	profileName: string,
): Promise<boolean> {
	const confirmUrl = `${SITE_URL}/alertas/confirmar?token=${token}`;
	const cancelUrl = `${SITE_URL}/alertas/cancelar?token=${token}`;

	const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0b1120;">
  <h2 style="font-family: Georgia, serif; color: #1a365d; margin-bottom: 8px;">Confirma tu suscripcion</h2>
  <p style="color: #4a6078; line-height: 1.6;">
    Has solicitado recibir alertas del perfil <strong>${profileName}</strong> en Ley Abierta.
  </p>
  <p style="margin: 24px 0;">
    <a href="${confirmUrl}" style="display: inline-block; padding: 12px 24px; background: #1a365d; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">
      Confirmar suscripcion
    </a>
  </p>
  <p style="color: #6b8299; font-size: 14px; line-height: 1.5;">
    Si no has sido tu, puedes ignorar este email o <a href="${cancelUrl}" style="color: #2b5797;">cancelar la suscripcion</a>.
  </p>
  <hr style="border: none; border-top: 1px solid #e8ecf0; margin: 24px 0;" />
  <p style="color: #6b8299; font-size: 12px;">
    Ley Abierta — Legislacion espanola consolidada, accesible para todos.
  </p>
</body>
</html>`.trim();

	if (!resend) {
		console.log(`[email-dry-run] Confirmation to ${email}: ${confirmUrl}`);
		return true;
	}

	try {
		await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject: "Confirma tu suscripcion — Ley Abierta",
			html,
		});
		return true;
	} catch (err) {
		console.error("[email] Failed to send confirmation:", err);
		return false;
	}
}

export interface DigestItem {
	id: string;
	title: string;
	rank: string;
	date: string;
}

export function buildDigestHtml(
	profileName: string,
	jurisdiction: string,
	items: DigestItem[],
	unsubToken: string,
): string {
	const cancelUrl = `${SITE_URL}/alertas/cancelar?token=${unsubToken}`;
	const prefsUrl = `${SITE_URL}/alertas`;

	const itemsHtml = items
		.map(
			(item) => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #e8ecf0;">
        <a href="${SITE_URL}/laws/${item.id}" style="color: #1a365d; text-decoration: none; font-weight: 500; font-size: 15px;">
          ${escapeHtml(item.title)}
        </a>
        <br />
        <span style="color: #6b8299; font-size: 13px;">
          ${escapeHtml(item.rank)} · ${item.date}
        </span>
      </td>
    </tr>`,
		)
		.join("");

	return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #0b1120;">
  <h2 style="font-family: Georgia, serif; color: #1a365d; margin-bottom: 4px;">Tu resumen semanal</h2>
  <p style="color: #4a6078; margin-top: 4px; margin-bottom: 20px;">
    Perfil: <strong>${escapeHtml(profileName)}</strong> · ${escapeHtml(jurisdiction)}
  </p>
  <p style="color: #4a6078; line-height: 1.6;">
    Esta semana se han publicado <strong>${items.length} cambio${items.length === 1 ? "" : "s"}</strong> que te pueden afectar:
  </p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    ${itemsHtml}
  </table>
  <p style="margin-top: 24px;">
    <a href="${SITE_URL}" style="display: inline-block; padding: 10px 20px; background: #1a365d; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px;">
      Ver en Ley Abierta
    </a>
  </p>
  <hr style="border: none; border-top: 1px solid #e8ecf0; margin: 24px 0;" />
  <p style="color: #6b8299; font-size: 12px; line-height: 1.5;">
    Recibes esto porque sigues el perfil "${escapeHtml(profileName)}".
    <a href="${prefsUrl}" style="color: #2b5797;">Cambiar preferencias</a> ·
    <a href="${cancelUrl}" style="color: #2b5797;">Cancelar suscripcion</a>
  </p>
</body>
</html>`.trim();
}

export async function sendDigestEmail(
	email: string,
	profileName: string,
	jurisdiction: string,
	html: string,
): Promise<boolean> {
	const subject = `Ley Abierta — Tu resumen semanal (${profileName}, ${jurisdiction})`;

	if (!resend) {
		console.log(`[email-dry-run] Digest to ${email}: ${subject}`);
		return true;
	}

	try {
		await resend.emails.send({
			from: FROM_EMAIL,
			to: email,
			subject,
			html,
		});
		return true;
	} catch (err) {
		console.error(`[email] Failed to send digest to ${email}:`, err);
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
