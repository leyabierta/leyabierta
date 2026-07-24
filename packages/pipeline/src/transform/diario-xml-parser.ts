/**
 * BOE diario (daily bulletin) XML parser.
 *
 * Parses a single item's XML from `https://www.boe.es/diario_boe/xml.php`
 * into the same `Norm` shape the consolidated parser produces — but unlike
 * the consolidated `<bloque><version>` structure, the diario `<texto>` is a
 * FLAT, unversioned list of `<p>` elements: a snapshot of the norm as
 * published, with no reform history yet. We segment that flat list into
 * blocks ourselves and give each block exactly one `Version`.
 */

import { XMLParser } from "fast-xml-parser";
import type {
	Block,
	Norm,
	NormAnalisis,
	NormMetadata,
	Rank,
} from "../models.ts";
import { extractShortTitle, RANK_MAP } from "../spain/boe-metadata.ts";
import { parseBoeDate } from "../utils/date.ts";
import { extractJurisdiction } from "./slug.ts";
import {
	decodeEntities,
	normalizeWhitespace,
	renderInlineNodes,
	type XmlNode,
} from "./xml-inline.ts";
import { extractParagraphs, extractReforms } from "./xml-parser.ts";

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	preserveOrder: true,
	trimValues: false,
	processEntities: false, // We decode entities ourselves in renderInlineNodes
});

/**
 * Parse a diario item XML (`<documento><metadatos>…<analisis>…<texto>…`)
 * into a Norm with `metadata.origin = "diario"` and a single, unversioned
 * snapshot of the text.
 */
export function parseDiarioXml(bytes: Uint8Array): Norm {
	const text = new TextDecoder().decode(bytes);
	const doc = xmlParser.parse(text) as XmlNode[];

	const documento = findChild(doc, "documento");
	const documentoChildren: XmlNode[] = documento?.documento ?? [];

	const metadatosNode = findChild(documentoChildren, "metadatos");
	const metadatosChildren: XmlNode[] = metadatosNode?.metadatos ?? [];

	const metadata = parseMetadata(metadatosChildren);

	const analisisNode = findChild(documentoChildren, "analisis");
	const analisisChildren: XmlNode[] = analisisNode?.analisis ?? [];
	const analisis = parseAnalisis(analisisChildren);

	const textoNode = findChild(documentoChildren, "texto");
	const textoChildren: XmlNode[] = textoNode?.texto ?? [];
	const blocks = segmentBlocks(textoChildren, metadata);

	// The diario has no reform history yet — but every block carries exactly
	// one Version (normId = the norm's own id, date = fecha_publicacion), so
	// extractReforms() naturally collapses them into a single synthetic
	// "bootstrap" reform covering every block. Without this, `reforms` would
	// be empty and `commitNormsChronologically` would silently produce zero
	// commits for the norm.
	const reforms = extractReforms(blocks);

	return { metadata, blocks, reforms, analisis };
}

// ─── Metadata ───

function parseMetadata(nodes: XmlNode[]): NormMetadata {
	const id = nodeText(nodes, "identificador");
	const rangoCodigo = nodeAttr(nodes, "rango", "codigo");
	const rank = RANK_MAP[rangoCodigo ?? ""] ?? ("otro" as Rank);
	const title = cleanTitle(nodeText(nodes, "titulo"));
	const department = nodeText(nodes, "departamento");
	const publishedAt = parseBoeDate(nodeText(nodes, "fecha_publicacion"));
	const disposicionAt = parseBoeDate(nodeText(nodes, "fecha_disposicion"));
	const vigenciaAt = parseBoeDate(nodeText(nodes, "fecha_vigencia"));
	const eli = nodeText(nodes, "url_eli") || undefined;
	const pdfUrl = nodeText(nodes, "url_pdf") || undefined;
	const seccion = nodeText(nodes, "seccion") || undefined;
	const derogada = nodeText(nodes, "estatus_derogacion") === "S";

	const source = eli ?? `https://www.boe.es/buscar/act.php?id=${id}`;
	// Jurisdiction resolution goes through the shared helper (ELI URL, then
	// bulletin prefix). `extractJurisdiction` itself falls back to
	// `metadata.country` when neither matches — so that fallback field must
	// be a real value, never undefined, or a BOE-A item with no <url_eli>
	// would resolve to jurisdiction "undefined". State-level BOE items are
	// unambiguously "es" here: this is the diario, and <origen_legislativo
	// codigo="1"> ("Estatal") confirms it — mirrors the same "es" fallback
	// boe-metadata.ts uses for the consolidated path.
	const country = extractJurisdiction({
		source,
		id,
		country: "es",
	} as NormMetadata);

	return {
		title,
		shortTitle: extractShortTitle(title),
		id,
		country,
		rank,
		publishedAt: publishedAt ?? disposicionAt ?? "1900-01-01",
		status: derogada ? "derogada" : "vigente",
		department,
		source,
		updatedAt:
			vigenciaAt && vigenciaAt !== publishedAt ? vigenciaAt : undefined,
		pdfUrl,
		origin: "diario",
		consolidated: false,
		section: seccion,
	};
}

function cleanTitle(raw: string): string {
	return raw.replace(/\.$/, "").trim();
}

// ─── Analisis ───

function parseAnalisis(nodes: XmlNode[]): NormAnalisis {
	const materiasNode = findChild(nodes, "materias");
	const materias = childNodes(materiasNode, "materias", "materia").map((m) =>
		textOfNode(m, "materia"),
	);

	// Alertas are second-level subject tags in the diario — fold them into
	// materias so they behave like the consolidated /analisis "materias".
	const alertasNode = findChild(nodes, "alertas");
	const alertas = childNodes(alertasNode, "alertas", "alerta").map((a) =>
		textOfNode(a, "alerta"),
	);

	const notasNode = findChild(nodes, "notas");
	const notas = childNodes(notasNode, "notas", "nota").map((n) =>
		textOfNode(n, "nota"),
	);

	const referenciasNode = findChild(nodes, "referencias");
	const referenciasChildren: XmlNode[] = referenciasNode?.referencias ?? [];

	return {
		materias: [...materias, ...alertas],
		notas,
		referencias: {
			anteriores: parseReferencias(referenciasChildren, "anteriores"),
			posteriores: parseReferencias(referenciasChildren, "posteriores"),
		},
	};
}

/**
 * Diario referencias put the relation label in `<palabra>` (e.g.
 * "DE CONFORMIDAD con", "CITA") — unlike the consolidated `/analisis`
 * endpoint, where it's in `<relacion><texto>`.
 */
function parseReferencias(
	nodes: XmlNode[],
	group: "anteriores" | "posteriores",
): Array<{ normId: string; relation: string; text: string }> {
	const groupNode = findChild(nodes, group);
	const items = childNodes(
		groupNode,
		group,
		group === "anteriores" ? "anterior" : "posterior",
	);

	return items.map((item) => {
		const tag = group === "anteriores" ? "anterior" : "posterior";
		const children: XmlNode[] = item[tag] ?? [];
		return {
			normId: nodeAttr([item], tag, "referencia") ?? "",
			relation: nodeText(children, "palabra"),
			text: nodeText(children, "texto"),
		};
	});
}

// ─── Block segmentation ───

const FIRMA_CLASSES = new Set(["firma_rey", "firma_ministro"]);

/**
 * Segment the flat `<texto><p>…` list into blocks:
 *   - everything before the first `p.articulo` → a single "preambulo" block
 *   - each `p.articulo` opens a new "precepto" block, titled from that <p>
 *   - each `p.anexo_num` opens a new "anexo" block (title includes the
 *     following `p.anexo_tit`, if present)
 *   - `p.firma_rey` / `p.firma_ministro` open (or continue) a "firma" block
 *
 * Each resulting block gets exactly one Version, dated at the norm's own
 * publication date (the diario has no reform history — that only exists
 * once the consolidated text arrives).
 */
function segmentBlocks(
	textoChildren: XmlNode[],
	metadata: NormMetadata,
): Block[] {
	interface Segment {
		id: string;
		type: string;
		title: string;
		children: XmlNode[];
	}

	const segments: Segment[] = [
		{ id: "preambulo", type: "preambulo", title: "", children: [] },
	];
	let articuloCount = 0;
	let anexoCount = 0;

	for (const node of textoChildren) {
		const cssClass = paragraphClass(node);

		if (cssClass === "articulo") {
			articuloCount += 1;
			segments.push({
				id: `a${articuloCount}`,
				type: "precepto",
				title: paragraphText(node),
				children: [],
			});
			continue; // the title <p> itself is not part of the block's body
		}

		if (cssClass === "anexo_num") {
			anexoCount += 1;
			segments.push({
				id: `anexo${anexoCount}`,
				type: "anexo",
				title: paragraphText(node),
				children: [],
			});
			continue;
		}

		if (cssClass === "anexo_tit") {
			const last = segments[segments.length - 1];
			if (last && last.type === "anexo") {
				last.title = last.title
					? `${last.title} — ${paragraphText(node)}`
					: paragraphText(node);
				continue;
			}
			// anexo_tit with no preceding anexo_num (real BOE annexes sometimes
			// lead with the title line) — it still opens a new anexo block
			// rather than becoming a stray paragraph in whatever block came
			// before it.
			anexoCount += 1;
			segments.push({
				id: `anexo${anexoCount}`,
				type: "anexo",
				title: paragraphText(node),
				children: [],
			});
			continue;
		}

		if (cssClass && FIRMA_CLASSES.has(cssClass)) {
			const last = segments[segments.length - 1];
			if (!last || last.type !== "firma") {
				segments.push({ id: "firma", type: "firma", title: "", children: [] });
			}
			segments[segments.length - 1]!.children.push(node);
			continue;
		}

		segments[segments.length - 1]!.children.push(node);
	}

	const published = metadata.publishedAt;

	return segments
		.filter((s) => s.children.length > 0 || s.type !== "preambulo")
		.map((s) => ({
			id: s.id,
			type: s.type,
			title: s.title,
			versions: [
				{
					normId: metadata.id,
					publishedAt: published,
					effectiveAt: published,
					paragraphs: extractParagraphs(s.children),
				},
			],
		}));
}

/** The `class` attribute of a `<p>` node, if this XmlNode is one. */
function paragraphClass(node: XmlNode): string | undefined {
	if (!node.p) return undefined;
	return (node[":@"]?.class as string) ?? undefined;
}

/** Rendered, normalized text of a `<p>` node. */
function paragraphText(node: XmlNode): string {
	return normalizeWhitespace(renderInlineNodes(node.p as XmlNode[]));
}

// ─── Generic preserveOrder XML helpers ───

/** Find the child object carrying the given tag key, e.g. `{ titulo: [...] }`. */
function findChild(nodes: XmlNode[], tag: string): XmlNode | undefined {
	return nodes.find((n) => n[tag] !== undefined);
}

/** Concatenated #text content of a tag's children. */
function nodeText(nodes: XmlNode[], tag: string): string {
	const node = findChild(nodes, tag);
	if (!node) return "";
	return textOfNode(node, tag);
}

/** Concatenated #text content of an already-located tag node. */
function textOfNode(node: XmlNode, tag: string): string {
	const children: XmlNode[] = node[tag] ?? [];
	return decodeEntities(
		children
			.map((c) => (c["#text"] !== undefined ? String(c["#text"]) : ""))
			.join(""),
	).trim();
}

/** Attribute value of a tag node, e.g. `<rango codigo="1340">` → codigo. */
function nodeAttr(
	nodes: XmlNode[],
	tag: string,
	attr: string,
): string | undefined {
	const node = findChild(nodes, tag);
	return node?.[":@"]?.[attr] as string | undefined;
}

/**
 * All repeated child elements with tag `itemTag` inside a group node
 * (`<materias><materia/>…</materias>`), normalizing the single-vs-array
 * shape that `preserveOrder` XML parsing does NOT collapse the way the
 * JSON API does — here it's always an array per element occurrence, so
 * this just extracts the group's children array.
 */
function childNodes(
	groupNode: XmlNode | undefined,
	groupTag: string,
	itemTag: string,
): XmlNode[] {
	if (!groupNode) return [];
	const children: XmlNode[] = groupNode[groupTag] ?? [];
	return children.filter((c) => c[itemTag] !== undefined);
}
