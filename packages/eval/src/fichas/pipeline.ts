/**
 * Multi-step citizen ficha pipeline.
 *
 *   1. chunk    — the law split by structure (chunk.ts): each article,
 *                 disposition, annex or amendment item is a piece, with the
 *                 previous wording of what it rewrites; short pieces grouped.
 *   2. extract  — one call per piece (in parallel) → facts with verbatim quotes.
 *   3. merge    — one call over the facts (not the text): group duplicates,
 *                 profiles, order by impact.
 *   4. write    — ficha (same schema as run.ts) from the merged facts only;
 *                 every item names the facts that support it.
 *   5. verify   — every claim judged against the source passages of its
 *                 facts' quotes; unsupported claims are corrected or removed.
 *                 Then the mechanical checks of render.ts.
 *
 * Intermediates go to <work>/<law>/ (pieces, extractions, merge, write,
 * verify) and are reused on a rerun; --from <step> recomputes from a step on.
 *
 * Any OpenAI-compatible endpoint works (--base-url, --api-key-env); each step
 * can use its own model. Public legislation only: never send a citizen's
 * question through this script.
 *
 *   bun run packages/eval/src/fichas/pipeline.ts --laws id1,id2 --src DIR \
 *     --out DIR [--model M] [--extract-model M] [--merge-model M] \
 *     [--write-model M] [--verify-model M] [--base-url URL] \
 *     [--api-key-env OPENROUTER_API_KEY] [--extra-body JSON] \
 *     [--provider-order DeepInfra,InferenceNet] \
 *     [--reasoning low] [--extract-reasoning …] [--write-reasoning …] \
 *     [--verify-reasoning …] [--budget 0.80] [--reserve 0.03] \
 *     [--concurrency 6] [--from extract|merge|write|verify|render] [--slug NAME]
 *
 * DIR (--src) holds src-<id>.md, prev-<id>.md and meta-<id>.json, as for run.ts.
 * --budget is a hard USD limit over the ledger (<work>/ledger.jsonl), so it
 * holds across reruns; cost is read from `usage.cost` (OpenRouter).
 */

import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { chunkLaw, locate, type Piece } from "./chunk.ts";
import { BudgetExceeded, type CallInfo, LlmClient, pool } from "./llm.ts";
import {
	MERGE_SYSTEM,
	MULTI_PROMPT_VERSION,
	PIECE_SYSTEM,
	pieceUser,
	VERIFY_SYSTEM,
	WRITE_SYSTEM,
} from "./prompts-multi.ts";
import { checkFicha, type Ficha, renderFicha } from "./render.ts";

const { values } = parseArgs({
	options: {
		laws: { type: "string" },
		src: { type: "string" },
		out: { type: "string" },
		work: { type: "string" },
		model: { type: "string", default: "deepseek/deepseek-v4.1-flash" },
		"extract-model": { type: "string" },
		"merge-model": { type: "string" },
		"write-model": { type: "string" },
		"verify-model": { type: "string" },
		"base-url": { type: "string", default: "https://openrouter.ai/api/v1" },
		"api-key-env": { type: "string", default: "OPENROUTER_API_KEY" },
		"extra-body": { type: "string" },
		"provider-order": { type: "string" },
		reasoning: { type: "string", default: "low" },
		"extract-reasoning": { type: "string" },
		"write-reasoning": { type: "string" },
		"verify-reasoning": { type: "string" },
		budget: { type: "string", default: "0.80" },
		reserve: { type: "string", default: "0.03" },
		concurrency: { type: "string", default: "6" },
		"verify-batch": { type: "string", default: "10" },
		from: { type: "string" },
		slug: { type: "string" },
	},
});

const apiKey = process.env[values["api-key-env"] ?? ""];
if (!values.laws || !values.src || !values.out || !apiKey) {
	console.error(
		"usage: pipeline.ts --laws id1,id2 --src DIR --out DIR [--model M …] (API key env var required)",
	);
	process.exit(1);
}
const SRC = values.src;
const OUT = values.out;
const WORK = values.work ?? `${OUT}/work`;
mkdirSync(WORK, { recursive: true });

const models = {
	extract: values["extract-model"] ?? values.model ?? "",
	merge: values["merge-model"] ?? values["write-model"] ?? values.model ?? "",
	write: values["write-model"] ?? values.model ?? "",
	verify: values["verify-model"] ?? values.model ?? "",
};
const reasoning = {
	extract: values["extract-reasoning"] ?? values.reasoning,
	merge: values["write-reasoning"] ?? values.reasoning,
	write: values["write-reasoning"] ?? values.reasoning,
	verify: values["verify-reasoning"] ?? values.reasoning,
};
const STEPS = ["extract", "merge", "write", "verify"] as const;
// --from render: no model calls, re-apply cached verdicts and re-render.
const rerender = values.from === "render";
const fromStep =
	values.from && !rerender
		? STEPS.indexOf(values.from as (typeof STEPS)[number])
		: STEPS.length;
if (values.from && !rerender && fromStep < 0) {
	console.error(`--from must be one of ${STEPS.join(", ")}, render`);
	process.exit(1);
}
const concurrency = Number(values.concurrency);
const verifyBatch = Number(values["verify-batch"]);
const slug = values.slug ?? models.write.replace(/[/:]/g, "_");

const llm = new LlmClient({
	baseUrl: values["base-url"] ?? "",
	apiKey,
	budget: Number(values.budget),
	reserve: Number(values.reserve),
	ledgerPath: `${WORK}/ledger.jsonl`,
	providerOrder: values["provider-order"]?.split(",").filter(Boolean),
	extraBody: values["extra-body"]
		? JSON.parse(values["extra-body"])
		: undefined,
});
console.log(
	`budget ${values.budget} | already spent (ledger) ${llm.priorSpend.toFixed(4)} | models ${JSON.stringify(models)}`,
);

// ---------------------------------------------------------------- types

interface Fact {
	id: string;
	piece: string;
	tipo?: string;
	tema?: string;
	que?: string;
	antes?: string | null;
	ahora?: string | null;
	afecta_a?: string[];
	cifras?: string[];
	cuando?: string | null;
	consecuencia?: string | null;
	impacto?: string;
	ref?: string;
	cita?: string;
	cita_antes?: string | null;
	cita_ok?: boolean;
}

interface Extraction {
	piece: string;
	info: CallInfo;
	modifica: Array<{ norma?: string; articulos?: string[] }>;
	hechos: Fact[];
}

interface Merge {
	tipo?: string;
	objeto?: string;
	naturaleza?: string | null;
	temas: Array<{
		tema?: string;
		hechos: string[];
		perfiles?: string[];
		impacto?: string;
	}>;
	descartar?: string[];
}

interface Item {
	texto?: string;
	hechos?: string[];
}
interface Draft {
	titular?: Item;
	resumen?: Item[];
	modifica?: string[];
	cambios?: Array<{
		tema?: string;
		antes?: string | null;
		ahora?: string;
		ref?: string;
		hechos?: string[];
	}>;
	perfiles?: Array<{ si_eres?: string; puntos?: Item[] }>;
	fechas?: Array<{
		que?: string;
		cuando?: string;
		ref?: string;
		hechos?: string[];
	}>;
	que_no_hace?: Item[];
	dudas?: Item[];
}

interface Claim {
	id: string;
	section: string;
	/** Path into the draft, e.g. ["perfiles", 1, "puntos", 0]. */
	path: Array<string | number>;
	campos: Record<string, string | null>;
	hechos: string[];
}

interface Verdict {
	id: string;
	veredicto?: string;
	problema?: string | null;
	correccion?: Record<string, string | null> | null;
}

// ---------------------------------------------------------------- helpers

const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[«»“”"'‘’>*]/g, "")
		.replace(/[–—]/g, "-")
		.replace(/\s+/g, " ")
		.trim();

const quoteIn = (quote: string | null | undefined, text: string) => {
	if (!quote) return false;
	const q = norm(quote).replace(/^[.…\s]+|[.…;,:\s]+$/g, "");
	return q.length > 0 && norm(text).includes(q);
};

async function cached<T>(
	path: string,
	step: number,
	make: () => Promise<T>,
): Promise<T> {
	const f = Bun.file(path);
	if (step < fromStep && (await f.exists())) return (await f.json()) as T;
	const v = await make();
	await Bun.write(path, JSON.stringify(v, null, 2));
	return v;
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// ---------------------------------------------------------------- steps

async function extractPiece(
	lawId: string,
	meta: { title: string; published_at: string },
	p: Piece,
	dir: string,
): Promise<Extraction> {
	return cached(`${dir}/extract-${p.id}.json`, 0, async () => {
		try {
			return await extractText(lawId, meta, p, p.text, "");
		} catch (e) {
			// A dense piece can exhaust max_tokens on every attempt: split its
			// text in two at a paragraph break and extract each half.
			if (!/max_tokens/.test((e as Error).message)) throw e;
			const halves = splitHalf(p.text);
			if (!halves) throw e;
			console.warn(`  ${lawId} ${p.id}: output too long, splitting in two`);
			const parts: Extraction[] = [];
			for (const [i, t] of halves.entries())
				parts.push(await extractText(lawId, meta, p, t, i ? "b" : "a"));
			const failed = (e as { info?: CallInfo }).info;
			const infos = [...(failed ? [failed] : []), ...parts.map((x) => x.info)];
			return {
				piece: p.id,
				info: {
					...(parts[0] as Extraction).info,
					cost: infos.reduce((n, x) => n + x.cost, 0),
					ms: infos.reduce((n, x) => n + x.ms, 0),
					tokensIn: infos.reduce((n, x) => n + x.tokensIn, 0),
					tokensOut: infos.reduce((n, x) => n + x.tokensOut, 0),
				},
				modifica: parts.flatMap((x) => x.modifica),
				hechos: parts.flatMap((x) => x.hechos),
			};
		}
	});
}

/** Split at the paragraph break closest to the middle; null if none. */
function splitHalf(text: string): [string, string] | null {
	const mid = text.length / 2;
	let best = -1;
	for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n", i + 2))
		if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
	if (best <= 0 || best >= text.length - 2) return null;
	return [text.slice(0, best).trim(), text.slice(best).trim()];
}

async function extractText(
	lawId: string,
	meta: { title: string; published_at: string },
	p: Piece,
	text: string,
	suffix: string,
): Promise<Extraction> {
	{
		const { data, info } = await llm.json<{
			modifica?: unknown;
			hechos?: unknown;
		}>({
			tag: `${lawId} extract ${p.id}${suffix}`,
			step: "extract",
			model: models.extract,
			reasoning: reasoning.extract,
			system: PIECE_SYSTEM,
			maxTokens: 12000,
			validate: (d) => (Array.isArray(d.hechos) ? null : "no 'hechos' array"),
			user: pieceUser({
				title: meta.title,
				publishedAt: meta.published_at,
				context: p.context,
				kind: p.kind,
				text,
				prev: p.prev,
			}),
		});
		const pieceSource = `${text}\n${p.prev.map((b) => b.text).join("\n")}`;
		const hechos = asArray<Fact>(data.hechos).map((h, i) => ({
			...h,
			id: `${p.id}${suffix}-${i + 1}`,
			piece: p.id,
			cita_ok: quoteIn(h.cita, pieceSource),
		}));
		console.log(
			`  ${lawId} ${p.id}${suffix}: ${hechos.length} facts (${hechos.filter((h) => !h.cita_ok).length} quotes not found) $${info.cost.toFixed(4)} ${(info.ms / 1000).toFixed(0)}s`,
		);
		return {
			piece: p.id,
			info,
			modifica: asArray(data.modifica),
			hechos,
		};
	}
}

function mergeModifica(
	exs: Extraction[],
): Array<{ norma: string; articulos: string[] }> {
	const byLaw = new Map<string, { norma: string; articulos: Set<string> }>();
	for (const e of exs)
		for (const m of e.modifica) {
			if (!m.norma) continue;
			const k = norm(m.norma);
			const cur = byLaw.get(k) ?? { norma: m.norma, articulos: new Set() };
			for (const a of asArray<string>(m.articulos))
				cur.articulos.add(String(a));
			byLaw.set(k, cur);
		}
	return [...byLaw.values()].map((v) => ({
		norma: v.norma,
		articulos: [...v.articulos],
	}));
}

async function mergeFacts(
	lawId: string,
	meta: { title: string },
	facts: Fact[],
	dir: string,
): Promise<{ merge: Merge; info: CallInfo | null }> {
	return cached(`${dir}/merge.json`, 1, async () => {
		const compact = facts.map((f) => ({
			id: f.id,
			tipo: f.tipo,
			tema: f.tema,
			que: f.que,
			afecta_a: f.afecta_a,
			impacto: f.impacto,
			ref: f.ref,
		}));
		const { data, info } = await llm.json<Merge>({
			tag: `${lawId} merge`,
			step: "merge",
			model: models.merge,
			reasoning: reasoning.merge,
			system: MERGE_SYSTEM,
			validate: (d) => (Array.isArray(d.temas) ? null : "no 'temas' array"),
			user: `Norma: ${meta.title}\n\nHechos (${facts.length}):\n${JSON.stringify(compact)}`,
		});
		// Every fact must land somewhere: unknown ids dropped, missing ids kept.
		const known = new Set(facts.map((f) => f.id));
		const seen = new Set<string>();
		const temas = asArray<Merge["temas"][number]>(data.temas)
			.map((t) => ({
				...t,
				hechos: asArray<string>(t.hechos).filter((id) => {
					if (!known.has(id) || seen.has(id)) return false;
					seen.add(id);
					return true;
				}),
			}))
			.filter((t) => t.hechos.length);
		const descartar = asArray<string>(data.descartar).filter(
			(id) => known.has(id) && !seen.has(id),
		);
		for (const id of descartar) seen.add(id);
		const missing = facts.filter((f) => !seen.has(f.id)).map((f) => f.id);
		if (missing.length)
			temas.push({
				tema: "Otros (sin agrupar)",
				hechos: missing,
				perfiles: [],
				impacto: "bajo",
			});
		console.log(
			`  ${lawId} merge: ${temas.length} themes, ${descartar.length} discarded, ${missing.length} unassigned $${info.cost.toFixed(4)} ${(info.ms / 1000).toFixed(0)}s`,
		);
		return { merge: { ...data, temas, descartar }, info };
	});
}

async function writeDraft(
	lawId: string,
	meta: { title: string; published_at: string },
	merge: Merge,
	modifica: Array<{ norma: string; articulos: string[] }>,
	byId: Map<string, Fact>,
	dir: string,
): Promise<{ draft: Draft; info: CallInfo }> {
	return cached(`${dir}/write.json`, 2, async () => {
		const input = {
			norma: meta.title,
			publicada_en_boe: meta.published_at,
			tipo: merge.tipo,
			objeto: merge.objeto,
			naturaleza: merge.naturaleza,
			modifica,
			temas: merge.temas.map((t) => ({
				tema: t.tema,
				impacto: t.impacto,
				perfiles: t.perfiles,
				hechos: t.hechos.map((id) => {
					const { piece: _p, cita_ok: _c, ...f } = byId.get(id) as Fact;
					return f;
				}),
			})),
		};
		const { data, info } = await llm.json<Draft>({
			tag: `${lawId} write`,
			step: "write",
			model: models.write,
			reasoning: reasoning.write,
			system: WRITE_SYSTEM,
			validate: (d) =>
				Array.isArray(d.cambios) && d.titular
					? null
					: "no 'cambios' or 'titular'",
			user: JSON.stringify(input, null, 1),
		});
		console.log(
			`  ${lawId} write: ${asArray(data.cambios).length} changes $${info.cost.toFixed(4)} ${(info.ms / 1000).toFixed(0)}s`,
		);
		return { draft: data, info };
	});
}

function claimsOf(d: Draft): Claim[] {
	const out: Claim[] = [];
	const add = (
		section: string,
		path: Array<string | number>,
		campos: Record<string, string | null>,
		hechos: unknown,
	) =>
		out.push({
			id: `c${out.length + 1}`,
			section,
			path,
			campos,
			hechos: asArray<string>(hechos),
		});
	if (d.titular?.texto)
		add("titular", ["titular"], { texto: d.titular.texto }, d.titular.hechos);
	asArray<Item>(d.resumen).forEach((r, i) => {
		add("resumen", ["resumen", i], { texto: r.texto ?? "" }, r.hechos);
	});
	asArray<NonNullable<Draft["cambios"]>[number]>(d.cambios).forEach((c, i) => {
		add(
			"cambios",
			["cambios", i],
			{ tema: c.tema ?? "", antes: c.antes ?? null, ahora: c.ahora ?? "" },
			c.hechos,
		);
	});
	asArray<NonNullable<Draft["perfiles"]>[number]>(d.perfiles).forEach(
		(p, i) => {
			asArray<Item>(p.puntos).forEach((pt, k) => {
				add(
					`perfil: ${p.si_eres ?? ""}`,
					["perfiles", i, "puntos", k],
					{ texto: pt.texto ?? "" },
					pt.hechos,
				);
			});
		},
	);
	asArray<NonNullable<Draft["fechas"]>[number]>(d.fechas).forEach((f, i) => {
		add(
			"fechas",
			["fechas", i],
			{ que: f.que ?? "", cuando: f.cuando ?? "" },
			f.hechos,
		);
	});
	asArray<Item>(d.que_no_hace).forEach((r, i) => {
		add("que_no_hace", ["que_no_hace", i], { texto: r.texto ?? "" }, r.hechos);
	});
	asArray<Item>(d.dudas).forEach((r, i) => {
		add("dudas", ["dudas", i], { texto: r.texto ?? "" }, r.hechos);
	});
	return out;
}

/** Source passages that should support a claim: the paragraphs of its facts' quotes. */
function passagesFor(
	claim: Claim,
	facts: Fact[],
	byId: Map<string, Fact>,
	pieces: Map<string, Piece>,
	source: string,
): Array<{ ref: string; de: string; pasaje: string }> {
	let fs = claim.hechos.map((id) => byId.get(id)).filter((f): f is Fact => !!f);
	if (!fs.length) {
		// Writer gave no usable ids: fall back to the facts its [refs] name.
		const refs = Object.values(claim.campos)
			.join(" ")
			.match(/\[[^\]]+\]/g)
			?.map((r) => norm(r.slice(1, -1)));
		if (refs?.length)
			fs = facts.filter(
				(f) => f.ref && refs.some((r) => r.includes(norm(f.ref ?? ""))),
			);
	}
	const out: Array<{ ref: string; de: string; pasaje: string }> = [];
	const seen = new Set<string>();
	for (const f of fs.slice(0, 8)) {
		const p = pieces.get(f.piece);
		const pieceNew = p?.text ?? "";
		const piecePrev =
			p?.prev.map((b) => `${b.header}\n\n${b.text}`).join("\n\n") ?? "";
		const add = (de: string, pasaje: string | null) => {
			if (!pasaje || seen.has(pasaje)) return;
			seen.add(pasaje);
			out.push({ ref: f.ref ?? "", de, pasaje });
		};
		if (f.cita) {
			const at =
				locate(pieceNew, f.cita) ??
				locate(piecePrev, f.cita) ??
				locate(source, f.cita);
			add(
				"norma",
				at ?? `${f.cita} (cita no localizada literalmente en la fuente)`,
			);
		}
		if (f.cita_antes)
			add(
				"redacción anterior",
				locate(piecePrev, f.cita_antes) ?? locate(source, f.cita_antes),
			);
		// An amendment may rewrite one paragraph of a provision whose unchanged
		// opening holds the penalty or subject: add that opening.
		const blocks = p?.prev ?? [];
		const mine = blocks.filter((b) => {
			const num = b.label.match(/\d+(?:\s+(?:bis|ter|quater))?/)?.[0];
			return num && new RegExp(`\\b${num}\\b`).test(f.ref ?? "");
		});
		const pick = mine.length ? mine : blocks.length === 1 ? blocks : [];
		for (const b of pick.slice(0, 2))
			add(
				"redacción vigente del precepto modificado (inicio)",
				`${b.header}\n\n${b.text.length > 900 ? `${b.text.slice(0, 900)}…` : b.text}`,
			);
	}
	return out;
}

function getAt(obj: unknown, path: Array<string | number>): unknown {
	let cur = obj as Record<string | number, unknown> | undefined;
	for (const k of path)
		cur = cur?.[k] as Record<string | number, unknown> | undefined;
	return cur;
}

async function verifyDraft(
	lawId: string,
	meta: { title: string },
	draft: Draft,
	facts: Fact[],
	byId: Map<string, Fact>,
	pieces: Map<string, Piece>,
	source: string,
	dir: string,
): Promise<{ claims: Array<Claim & { verdict: Verdict }>; infos: CallInfo[] }> {
	return cached(`${dir}/verify.json`, 3, async () => {
		const claims = claimsOf(draft);
		const payload = claims.map((c) => ({
			id: c.id,
			seccion: c.section,
			campos: c.campos,
			numeros_no_en_fuente: checkFicha([], c.campos, source).unsupportedNumbers,
			pasajes: passagesFor(c, facts, byId, pieces, source),
		}));
		const batches: (typeof payload)[] = [];
		for (let i = 0; i < payload.length; i += verifyBatch)
			batches.push(payload.slice(i, i + verifyBatch));
		const infos: CallInfo[] = [];
		const verdicts = new Map<string, Verdict>();
		await pool(batches, concurrency, async (batch, b) => {
			try {
				const { data, info } = await llm.json<{ resultados?: unknown }>({
					tag: `${lawId} verify ${b + 1}/${batches.length}`,
					step: "verify",
					model: models.verify,
					reasoning: reasoning.verify,
					system: VERIFY_SYSTEM,
					validate: (d) =>
						Array.isArray(d.resultados) ? null : "no 'resultados' array",
					user: `Norma: ${meta.title}\n\nAfirmaciones:\n${JSON.stringify(batch, null, 1)}`,
				});
				infos.push(info);
				for (const v of asArray<Verdict>(data.resultados))
					verdicts.set(v.id, v);
			} catch (e) {
				if (e instanceof BudgetExceeded) throw e;
				console.warn(
					`  ${lawId} verify batch ${b + 1} failed: ${(e as Error).message}`,
				);
			}
		});
		const out = claims.map((c) => ({
			...c,
			passages: payload.find((p) => p.id === c.id)?.pasajes,
			verdict: verdicts.get(c.id) ?? { id: c.id, veredicto: "sin_verificar" },
		}));
		const cost = infos.reduce((n, i) => n + i.cost, 0);
		console.log(
			`  ${lawId} verify: ${claims.length} claims in ${batches.length} calls $${cost.toFixed(4)}`,
		);
		return { claims: out, infos };
	});
}

/** Apply verdicts: keep supported claims, replace corrected ones, drop the rest. */
/** The model sometimes answers in the masculine form or with spaces. */
function normVerdict(v: string | undefined): string {
	const k = (v ?? "sin_verificar")
		.trim()
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[\s-]+/g, "_");
	if (k === "sostenido" || k === "sostenida") return "sostenida";
	if (k === "parcial" || k === "parcialmente_sostenida") return "parcial";
	if (k === "no_sostenido" || k === "no_sostenida") return "no_sostenida";
	return "sin_verificar";
}

function applyVerdicts(
	draft: Draft,
	claims: Array<Claim & { verdict: Verdict }>,
	fallbackTitular: string,
): { ficha: Ficha; corrected: number; removed: number; unverified: number } {
	const d = structuredClone(draft) as Draft;
	const drop = new Set<unknown>();
	let corrected = 0;
	let removed = 0;
	let unverified = 0;
	for (const c of claims) {
		const v = normVerdict(c.verdict.veredicto);
		if (v === "sostenida") continue;
		if (v !== "parcial" && v !== "no_sostenida") {
			unverified++;
			continue;
		}
		const target = getAt(d, c.path) as Record<string, unknown> | undefined;
		const fix = c.verdict.correccion;
		const usable =
			fix &&
			typeof fix === "object" &&
			Object.keys(c.campos).every(
				(k) =>
					k === "antes" ||
					(typeof fix[k] === "string" && (fix[k] as string).trim()),
			);
		if (target && usable) {
			for (const k of Object.keys(c.campos)) target[k] = fix[k] ?? null;
			corrected++;
		} else {
			if (target) drop.add(target);
			removed++;
		}
	}
	const keep = <T>(xs: T[] | undefined) =>
		(xs ?? []).filter((x) => !drop.has(x));
	const text = (xs: Item[] | undefined) =>
		keep(xs)
			.map((x) => x.texto ?? "")
			.filter(Boolean);
	const titular =
		d.titular && !drop.has(d.titular) && d.titular.texto
			? d.titular.texto
			: fallbackTitular;
	const ficha: Ficha = {
		titular,
		resumen: text(d.resumen),
		modifica: asArray<string>(d.modifica),
		cambios: keep(d.cambios).map(
			({ hechos: _h, ...c }) => c,
		) as Ficha["cambios"],
		perfiles: (d.perfiles ?? [])
			.map((p) => ({ si_eres: p.si_eres, puntos: text(p.puntos) }))
			.filter((p) => p.puntos.length),
		fechas: keep(d.fechas).map(({ hechos: _h, ...f }) => f),
		que_no_hace: text(d.que_no_hace),
		dudas: text(d.dudas),
	};
	return { ficha, corrected, removed, unverified };
}

// ---------------------------------------------------------------- per law

interface LawResult {
	law: string;
	cost: number;
	costThisRun: number;
	wallMs: number;
	callMs: number;
	pieces: number;
	facts: number;
	claims: number;
	corrected: number;
	removed: number;
	unverified: number;
}

async function runLaw(lawId: string): Promise<LawResult | null> {
	const outBase = `${OUT}/${lawId}__${slug}`;
	const prevRecord = rerender
		? ((await Bun.file(`${outBase}.json`).json()) as { wall_ms: number })
		: null;
	if (
		!rerender &&
		fromStep === STEPS.length &&
		(await Bun.file(`${outBase}.json`).exists())
	) {
		console.log(`skip ${lawId} (done; use --from to recompute)`);
		return null;
	}
	const t0 = Date.now();
	const spent0 = llm.spent;
	const dir = `${WORK}/${lawId}`;
	mkdirSync(dir, { recursive: true });
	const lawText = await Bun.file(`${SRC}/src-${lawId}.md`).text();
	const prevFile = Bun.file(`${SRC}/prev-${lawId}.md`);
	const prevText = (await prevFile.exists()) ? await prevFile.text() : "";
	const meta = (await Bun.file(`${SRC}/meta-${lawId}.json`).json()) as {
		title: string;
		published_at: string;
	};
	const source = `${lawText}\n${prevText}`;

	// 1. chunk
	const { pieces, unmatchedPrev } = chunkLaw(lawText, prevText);
	await Bun.write(
		`${dir}/pieces.json`,
		JSON.stringify({ unmatchedPrev, pieces }, null, 2),
	);
	console.log(
		`${lawId}: ${pieces.length} pieces${unmatchedPrev.length ? `, ${unmatchedPrev.length} previous-wording blocks unmatched` : ""}`,
	);
	const pieceMap = new Map(pieces.map((p) => [p.id, p]));

	// 2. extract
	const exs = await pool(pieces, concurrency, (p) =>
		extractPiece(lawId, meta, p, dir),
	);
	const facts = exs.flatMap((e) => e.hechos);
	const byId = new Map(facts.map((f) => [f.id, f]));
	const modifica = mergeModifica(exs);

	// 3. merge
	const { merge, info: mergeInfo } = await mergeFacts(lawId, meta, facts, dir);

	// 4. write
	const { draft, info: writeInfo } = await writeDraft(
		lawId,
		meta,
		merge,
		modifica,
		byId,
		dir,
	);

	// 5. verify
	const { claims, infos: verifyInfos } = await verifyDraft(
		lawId,
		meta,
		draft,
		facts,
		byId,
		pieceMap,
		source,
		dir,
	);
	const applied = applyVerdicts(draft, claims, merge.objeto ?? meta.title);
	const checks = checkFicha(facts, applied.ficha, source);

	const calls = [
		...exs.map((e) => e.info),
		...(mergeInfo ? [mergeInfo] : []),
		writeInfo,
		...verifyInfos,
	];
	const cost = calls.reduce((n, c) => n + c.cost, 0);
	const wallMs = prevRecord ? prevRecord.wall_ms : Date.now() - t0;
	const record = {
		law: lawId,
		model: models.write,
		models,
		base_url: values["base-url"],
		provider_order: values["provider-order"] ?? null,
		pipeline: "multi",
		prompt_version: MULTI_PROMPT_VERSION,
		reasoning,
		generated_at: new Date().toISOString(),
		cost,
		wall_ms: wallMs,
		calls,
		extraction: { modifica, hechos: facts },
		merge,
		verification: {
			claims: claims.length,
			corrected: applied.corrected,
			removed: applied.removed,
			unverified: applied.unverified,
			byVerdict: Object.fromEntries(
				["sostenida", "parcial", "no_sostenida", "sin_verificar"].map((v) => [
					v,
					claims.filter((c) => normVerdict(c.verdict.veredicto) === v).length,
				]),
			),
		},
		ficha: applied.ficha,
		checks,
	};
	await Bun.write(`${outBase}.json`, JSON.stringify(record, null, 2));
	await Bun.write(`${outBase}.md`, renderFicha(meta.title, applied.ficha));
	const res: LawResult = {
		law: lawId,
		cost,
		costThisRun: llm.spent - spent0,
		wallMs,
		callMs: calls.reduce((n, c) => n + c.ms, 0),
		pieces: pieces.length,
		facts: facts.length,
		claims: claims.length,
		corrected: applied.corrected,
		removed: applied.removed,
		unverified: applied.unverified,
	};
	console.log(
		`ok ${lawId} | $${cost.toFixed(4)} | ${(wallMs / 1000).toFixed(0)}s | facts ${facts.length} | claims ${claims.length}: corrected ${applied.corrected}, removed ${applied.removed}, unverified ${applied.unverified} | quotes ${checks.quotesFound}/${checks.quotesTotal} | numbers not in source: ${checks.unsupportedNumbers.join(" ") || "-"}`,
	);
	return res;
}

// ---------------------------------------------------------------- main

const results: LawResult[] = [];
const failures: string[] = [];
for (const law of values.laws.split(",")) {
	try {
		const r = await runLaw(law);
		if (r) results.push(r);
	} catch (e) {
		failures.push(`${law}: ${(e as Error).message}`);
		console.warn(`FAIL ${law}: ${(e as Error).message}`);
		if (e instanceof BudgetExceeded) break;
	}
}
if (results.length) {
	await Bun.write(
		`${WORK}/summary-${Date.now()}.json`,
		JSON.stringify(results, null, 2),
	);
	console.table(
		results.map((r) => ({
			law: r.law,
			usd: r.cost.toFixed(4),
			wall_s: Math.round(r.wallMs / 1000),
			pieces: r.pieces,
			facts: r.facts,
			claims: r.claims,
			corrected: r.corrected,
			removed: r.removed,
			unverified: r.unverified,
		})),
	);
}
console.log(
	`spent this run ${llm.spent.toFixed(4)} | ledger total ${llm.total.toFixed(4)} of ${values.budget}`,
);
if (failures.length) console.log(`failures:\n  ${failures.join("\n  ")}`);
