/** Escape HTML special characters to prevent XSS in rendered output. */
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Safely serialize an object for use in `<script type="application/ld+json">`.
 *  Escapes `<` and `>` to prevent `</script>` injection. */
export function safeJsonLd(obj: unknown): string {
	return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
