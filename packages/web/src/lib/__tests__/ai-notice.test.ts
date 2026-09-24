import { describe, expect, test } from "bun:test";
import { reformAiNoticeHtml } from "../ai-notice.ts";
import {
	type ReformDetailResponse,
	renderReformContent,
} from "../reform-render.ts";

const BOE = "https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-12345";

function detail(
	reform: Partial<ReformDetailResponse["reform"]>,
): ReformDetailResponse {
	return {
		law: {
			id: "BOE-A-2015-11430",
			title: "Estatuto de los Trabajadores",
			rank: "real_decreto_legislativo",
			status: "vigente",
			source_url: "https://www.boe.es/eli/es/rdlg/2015/10/23/2",
			last_reform_date: null,
		},
		reform: {
			date: "2026-09-01",
			reform_type: "modification",
			headline: "Cambia el permiso por nacimiento",
			summary: "El permiso pasa a 20 semanas.",
			importance: "normal",
			...reform,
		},
		affected_blocks: [],
		prev_reform_date: null,
		next_reform_date: null,
		source_url: BOE,
	};
}

const OPTS = {
	topicInfo: null,
	topicBlockIds: null,
	blocks: [],
	unifiedDiffHtml: null,
};

describe("reformAiNoticeHtml", () => {
	test("headline + summary: plural wording and BOE link", () => {
		const html = reformAiNoticeHtml({
			hasHeadline: true,
			hasSummary: true,
			sourceUrl: BOE,
		});
		expect(html).toContain(
			"El titular y el resumen están generados con inteligencia artificial y pueden contener errores.",
		);
		expect(html).toContain(`href="${BOE}"`);
		expect(html).toContain('href="/sobre/#resumenes-ia"');
		// The target=_blank link says so to screen readers.
		expect(html).toContain(
			'<span class="sr-only"> (se abre en una pestaña nueva)</span>',
		);
	});

	test("only one AI part: singular wording", () => {
		expect(
			reformAiNoticeHtml({
				hasHeadline: false,
				hasSummary: true,
				sourceUrl: BOE,
			}),
		).toContain("El resumen está generado con inteligencia artificial y puede");
	});

	test("no AI text: no notice", () => {
		expect(
			reformAiNoticeHtml({
				hasHeadline: false,
				hasSummary: false,
				sourceUrl: BOE,
			}),
		).toBe("");
	});

	test("escapes the source URL", () => {
		const html = reformAiNoticeHtml({
			hasHeadline: true,
			hasSummary: false,
			sourceUrl: 'x"><script>',
		});
		expect(html).not.toContain("<script>");
	});
});

describe("renderReformContent (Worker SSR) shows the AI notice", () => {
	test("AI headline: badge near the H1 and notice with the BOE link", () => {
		const { contentHtml } = renderReformContent(detail({}), OPTS);
		expect(contentHtml).toContain(
			'class="reforma-ai-badge">Generado con IA</a>',
		);
		expect(contentHtml).toContain('id="aviso-ia"');
		expect(contentHtml).toContain(`href="${BOE}"`);
		// The badge sits in the date row, before the H1.
		expect(contentHtml.indexOf("reforma-ai-badge")).toBeLessThan(
			contentHtml.indexOf("<h1"),
		);
	});

	test("no AI headline or summary: H1 is the law title, no notice", () => {
		const { contentHtml } = renderReformContent(
			detail({ headline: null, summary: null }),
			OPTS,
		);
		expect(contentHtml).not.toContain("reforma-ai-badge");
		expect(contentHtml).not.toContain("aviso-ia");
	});
});
