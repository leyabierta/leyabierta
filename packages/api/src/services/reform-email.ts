/**
 * HTML templates for the reform alert emails sent by
 * `scripts/send-notifications.ts`. Kept out of the script (which runs on
 * import) so the templates can be tested.
 *
 * Every headline and summary in these emails is AI-generated, so each email
 * says so and links to the official disposition on the BOE.
 */

export interface ReformEmailItem {
	id: string;
	title: string;
	date: string;
	source_id: string;
	headline: string | null;
	summary: string | null;
	reform_type: string | null;
	importance: string | null;
}

const MONTHS = [
	"ene",
	"feb",
	"mar",
	"abr",
	"may",
	"jun",
	"jul",
	"ago",
	"sep",
	"oct",
	"nov",
	"dic",
];

const TYPE_LABELS: Record<string, string> = {
	modification: "Modificación",
	modificacion: "Modificación",
	derogation: "Derogación",
	derogacion: "Derogación",
	correction: "Corrección",
	correccion: "Corrección",
	new_law: "Ley nueva",
	nueva: "Ley nueva",
};

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function formatDate(iso: string): string {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function reformUrl(siteUrl: string, r: ReformEmailItem): string {
	return `${siteUrl}/cambios/reforma/?id=${encodeURIComponent(r.id)}&date=${encodeURIComponent(r.date)}`;
}

/** The official disposition that made this reform, on the BOE. */
export function boeDispositionUrl(r: ReformEmailItem): string {
	return `https://www.boe.es/diario_boe/txt.php?id=${encodeURIComponent(r.source_id)}`;
}

/** Link target for "how we make the summaries". */
function aiExplainerUrl(siteUrl: string): string {
	return `${siteUrl}/sobre/#resumenes-ia`;
}

/** One-line AI notice under a reform: the summary is AI-made, the BOE rules. */
function buildAiNotice(r: ReformEmailItem, fontSize: number): string {
	return `<p style="margin:8px 0 0;font-size:${fontSize}px;color:#576b80;line-height:1.5;font-family:Arial,Helvetica,sans-serif;">Resumen generado con inteligencia artificial; puede contener errores. Fuente oficial: <a href="${boeDispositionUrl(r)}" style="color:#2b5797;">BOE</a>.</p>`;
}

function buildReformCard(siteUrl: string, r: ReformEmailItem): string {
	const isHigh = r.importance === "high";
	const borderColor = isHigh ? "#1a365d" : "#d1d5db";
	const typeLabel = TYPE_LABELS[r.reform_type?.toLowerCase() ?? ""] ?? "";
	const typePart = typeLabel ? ` &middot; ${escapeHtml(typeLabel)}` : "";
	const importanceBadge = isHigh
		? ' &nbsp;<span style="display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;background:#eef2f7;color:#1a365d;">Cambio importante</span>'
		: "";

	return `<tr><td style="padding:8px 0;">
<div style="border-left:3px solid ${borderColor};padding:12px 16px;">
  <p style="margin:0 0 4px;font-size:13px;color:#576b80;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(formatDate(r.date))}${typePart}${importanceBadge}</p>
  <p style="margin:4px 0;font-size:18px;font-weight:700;color:#0b1120;line-height:1.35;font-family:Georgia,'Times New Roman',Times,serif;">${escapeHtml(r.headline || r.title)}</p>
  <p style="margin:4px 0 0;font-size:15px;color:#4a6078;line-height:1.55;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
  ${buildAiNotice(r, 12)}
  <p style="margin:8px 0 0;"><a href="${reformUrl(siteUrl, r)}" style="font-size:13px;color:#2b5797;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">Ver qué cambió &#8594;</a></p>
</div>
</td></tr>`;
}

function buildFooter(siteUrl: string, unsubUrl: string): string {
	const prefsUrl = `${siteUrl}/mi-situacion`;
	return `<tr><td style="padding:0 28px 24px;">
  <hr style="border:none;border-top:1px solid #e8ecf0;margin:0 0 16px;">
  <p style="margin:0 0 6px;font-size:12px;color:#6b8299;line-height:1.6;font-family:Arial,Helvetica,sans-serif;">
    Los titulares y resúmenes de este correo los genera automáticamente un modelo de inteligencia artificial a partir del texto oficial. No son asesoramiento jurídico: lo que tiene validez es lo publicado en el BOE.
    <a href="${aiExplainerUrl(siteUrl)}" style="color:#2b5797;">Cómo los hacemos</a>
  </p>
  <p style="margin:0 0 6px;font-size:12px;color:#6b8299;line-height:1.6;font-family:Arial,Helvetica,sans-serif;">
    Recibes esto porque te suscribiste a alertas legislativas en Ley Abierta.
    <a href="${prefsUrl}" style="color:#2b5797;">Cambiar preferencias</a> &middot;
    <a href="${unsubUrl}" style="color:#2b5797;">Cancelar suscripción</a>
  </p>
  <p style="margin:0;font-size:11px;color:#9ca3af;font-family:Arial,Helvetica,sans-serif;">Fuente: Agencia Estatal BOE &middot; <a href="${siteUrl}" style="color:#9ca3af;">leyabierta.es</a></p>
</td></tr>`;
}

export function buildSingleReformHtml(
	siteUrl: string,
	r: ReformEmailItem,
	unsubUrl: string,
): string {
	const isHigh = r.importance === "high";
	const typeLabel = TYPE_LABELS[r.reform_type?.toLowerCase() ?? ""] ?? "";
	const typePart = typeLabel ? ` &middot; ${escapeHtml(typeLabel)}` : "";
	const importanceBadge = isHigh
		? ' <span style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;background:#eef2f7;color:#1a365d;margin-left:8px;">Cambio importante</span>'
		: "";

	return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(r.headline || r.title)}</title></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
<center>
<div style="max-width:600px;margin:0 auto;padding:24px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px;">
    <tr><td style="padding:28px 28px 0;">
      <p style="margin:0 0 16px;font-size:13px;color:#576b80;">${escapeHtml(formatDate(r.date))}${typePart} ${importanceBadge}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0b1120;line-height:1.3;font-family:Georgia,'Times New Roman',Times,serif;">${escapeHtml(r.headline || r.title)}</h1>
      <p style="margin:0 0 8px;font-size:16px;color:#4a6078;line-height:1.6;">${escapeHtml(r.summary || `Cambios en: ${r.title}`)}</p>
      ${buildAiNotice(r, 13)}
      <p style="margin:24px 0 28px;">
        <a href="${reformUrl(siteUrl, r)}" style="display:inline-block;padding:12px 28px;background:#1a365d;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Ver qué cambió &#8594;</a>
      </p>
    </td></tr>
    ${buildFooter(siteUrl, unsubUrl)}
  </table>
</div>
</center>
</body>
</html>`;
}

export function buildMultiReformHtml(
	siteUrl: string,
	reforms: ReformEmailItem[],
	introLine: string,
	unsubUrl: string,
	overflowCount: number,
): string {
	const cards = reforms.map((r) => buildReformCard(siteUrl, r)).join("\n");
	const overflow =
		overflowCount > 0
			? `<tr><td style="padding:4px 0 12px;font-size:13px;color:#576b80;font-family:Arial,Helvetica,sans-serif;">y ${overflowCount} más en <a href="${siteUrl}/cambios/para-mi/" style="color:#2b5797;">leyabierta.es/cambios/para-mi</a></td></tr>`
			: "";

	return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Tus cambios legislativos</title></head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
<center>
<div style="max-width:600px;margin:0 auto;padding:24px 0;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:8px 8px 0 0;">
    <tr><td style="padding:28px 28px 0;">
      <h1 style="margin:0;font-size:24px;font-weight:700;color:#0b1120;line-height:1.2;font-family:Georgia,'Times New Roman',Times,serif;">Tus cambios legislativos</h1>
    </td></tr>
    <tr><td style="padding:12px 28px 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f9fa;border-radius:6px;border-left:3px solid #1a365d;">
        <tr><td style="padding:12px 16px;font-size:15px;color:#4a6078;line-height:1.5;">
          ${escapeHtml(introLine)}
        </td></tr>
      </table>
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr><td style="padding:0 28px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        ${cards}
        ${overflow}
      </table>
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
    <tr><td style="padding:24px 28px;text-align:center;">
      <a href="${siteUrl}/cambios/para-mi/" style="display:inline-block;padding:12px 28px;background:#1a365d;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Ver todos tus cambios</a>
    </td></tr>
  </table>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:0 0 8px 8px;">
    ${buildFooter(siteUrl, unsubUrl)}
  </table>
</div>
</center>
</body>
</html>`;
}
