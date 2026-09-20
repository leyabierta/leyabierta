// Integration test for the worker's reform routing, with ASSETS and the API
// both stubbed. `wrangler dev` can't stand in for this: it needs the real API
// (and the 12k-file dist trips its asset watcher), so the path-form route would
// otherwise only ever be exercised in production.
import { afterEach, describe, expect, test } from "bun:test";
import worker, { type Env } from "../worker/index.ts";

const SHELL = `<!DOCTYPE html><html><head><title>Detalle de reforma — Ley Abierta</title>
<meta name="description" content="Qué ha cambiado en esta ley y por qué te importa." />
<meta name="robots" content="noindex, follow" />
<link rel="icon" href="/favicon.png" />
<meta property="og:title" content="Detalle de reforma — Ley Abierta" />
<meta property="og:description" content="x" /><meta property="og:url" content="x" />
<meta name="twitter:title" content="x" /><meta name="twitter:description" content="x" />
</head><body><div id="reforma-content"><div>cargando…</div></div></body></html>`;

// Shape mirrors GET /v1/reforms/:id/:date — trimmed, but the same fields the
// renderer reads. A hand-invented shape silently falls back to the shell.
const REFORM = {
	law: {
		id: "BOE-A-1978-31229",
		title: "Constitución Española",
		short_title: "Constitución Española",
		rank: "constitucion",
		status: "vigente",
		source_url: "https://www.boe.es/eli/es/c/1978/12/27/(1)",
		last_reform_date: "2026-05-20",
	},
	reform: {
		norm_id: "BOE-A-1978-31229",
		date: "2026-05-20",
		source_id: "BOE-A-2026-10881",
		headline: "Modificación del Artículo 69",
		summary: "Cambia la asignación de Senadores en provincias insulares.",
		importance: "medium",
	},
	affected_blocks: [
		{
			block_id: "a69",
			block_type: "precepto",
			title: "Artículo 69",
			before_text: "Artículo 69\n\n1. El Senado es la Cámara territorial.",
			after_text:
				"Artículo 69\n\n1. El Senado es la Cámara de representación territorial.",
		},
	],
	prev_reform_date: "2024-02-17",
	next_reform_date: null,
	source_url: "https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-10881",
};

/** ASSETS binding that always returns the shell, like the real one does. */
const assets = {
	fetch: async () =>
		new Response(SHELL, {
			status: 200,
			headers: { "content-type": "text/html" },
		}),
} as unknown as Fetcher;

const env: Env = { ASSETS: assets, PUBLIC_API_URL: "https://api.test" };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubApi(status: number, body: unknown = REFORM) {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

const get = (path: string) =>
	worker.fetch(new Request(`https://leyabierta.es${path}`), env);

describe("worker reform routing", () => {
	test("path form renders and becomes indexable", async () => {
		stubApi(200);
		const res = await get("/cambios/reforma/BOE-A-1978-31229/2026-05-20/");
		expect(res.status).toBe(200);
		const html = await res.text();

		expect(html).toContain("Modificación del Artículo 69");
		// The shell's noindex must be gone — this is real content now.
		expect(html).not.toContain('name="robots"');
		// ...and it must point at itself, in path form.
		expect(html).toContain(
			'<link rel="canonical" href="https://leyabierta.es/cambios/reforma/BOE-A-1978-31229/2026-05-20/" />',
		);
	});

	test("query form still renders, canonical stays query form outside the path arm", async () => {
		stubApi(200, {
			...REFORM,
			reform: { ...REFORM.reform, date: "2024-02-17" },
		});
		const res = await get(
			"/cambios/reforma/?id=BOE-A-1978-31229&date=2024-02-17",
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain('name="robots"');
		expect(html).toContain(
			'href="https://leyabierta.es/cambios/reforma/?id=BOE-A-1978-31229&amp;date=2024-02-17"',
		);
	});

	// The regression this guards: forwarding the inbound request to ASSETS for a
	// path-form URL would 404 (no such asset), handing crawlers a hard 404 for a
	// reform that merely failed to render. It must fall back to the shell.
	test("path form falls back to the shell when the API 404s", async () => {
		stubApi(404, { error: "not found" });
		const res = await get("/cambios/reforma/BOE-A-9999-9999/2026-01-01/");
		expect(res.status).toBe(404);
		const html = await res.text();
		expect(html).toContain("Detalle de reforma");
		// Fallback keeps the noindex — an empty shell must not be indexed.
		expect(html).toContain('name="robots"');
	});

	// The gap that let the P0 through: asserting on the Response HTML alone says
	// nothing about what the shell's client script does to it afterwards, and
	// Googlebot runs that script. The script bails on data-ssr, so the rendered
	// content survives.
	test("server-rendered content is flagged so the client script won't overwrite it", async () => {
		stubApi(200);
		const res = await get("/cambios/reforma/BOE-A-1978-31229/2026-05-20/");
		const html = await res.text();
		expect(html).toContain('<div id="reforma-content" data-ssr="1">');
	});

	test("the fallback shell is NOT flagged — the client script must take over", async () => {
		stubApi(404, { error: "not found" });
		const res = await get("/cambios/reforma/BOE-A-9999-9999/2026-01-01/");
		const html = await res.text();
		expect(html).not.toContain('data-ssr="1"');
	});

	test("the bare shell is served 200 with its noindex", async () => {
		stubApi(200);
		const res = await get("/cambios/reforma/");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('name="robots"');
	});

	test("a stray path under the prefix serves the shell, not a render", async () => {
		stubApi(200);
		const res = await get("/cambios/reforma/not-a-reform/");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('name="robots"');
	});
});

// `caches` doesn't exist under bun (see edgeCacheFor in worker/index.ts), so
// these tests install a fake `caches.default` to exercise the branch workerd
// actually takes in production. The regression this guards: before this,
// renderReformResponse built a fresh Response by hand on every hit — nothing
// ever reached the edge cache despite its `s-maxage=7776000` header — so a bot
// re-crawling the same reform re-ran the full API render each time. Measured
// 2026-09-20: GPTBot + ClaudeBot alone made 126k requests to this path in 7
// days after #161 made the reform sitemap crawlable, pushing the API past
// 160k requests and the Worker past its daily invocation cap.
describe("worker edge caching for rendered reforms", () => {
	afterEach(() => {
		// @ts-expect-error test-only global; absent in bun outside this block.
		globalThis.caches = undefined;
	});

	function fakeEdgeCache() {
		const store = new Map<string, Response>();
		const cache = {
			match: async (req: Request) => store.get(req.url)?.clone(),
			put: async (req: Request, res: Response) => {
				store.set(req.url, res);
			},
		};
		// @ts-expect-error test-only global; shaped like the real CacheStorage.
		globalThis.caches = { default: cache };
		return store;
	}

	test("a second hit to the same reform is served from cache, no re-render", async () => {
		let apiCalls = 0;
		globalThis.fetch = (async () => {
			apiCalls++;
			return new Response(JSON.stringify(REFORM), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		fakeEdgeCache();

		const waits: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (p: Promise<unknown>) => void waits.push(p),
		} as unknown as ExecutionContext;
		const request = () =>
			new Request(
				"https://leyabierta.es/cambios/reforma/BOE-A-1978-31229/2026-05-20/",
			);

		const first = await worker.fetch(request(), env, ctx);
		expect(first.status).toBe(200);
		await Promise.all(waits);
		expect(apiCalls).toBe(1);

		const second = await worker.fetch(request(), env, ctx);
		expect(second.status).toBe(200);
		expect(await second.text()).toContain("Modificación del Artículo 69");
		// No second render: the cache answered, the API was never hit again.
		expect(apiCalls).toBe(1);
	});

	test("a failed render (API 404) is never written to the edge cache", async () => {
		stubApi(404, { error: "not found" });
		const store = fakeEdgeCache();
		const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

		await worker.fetch(
			new Request(
				"https://leyabierta.es/cambios/reforma/BOE-A-9999-9999/2026-01-01/",
			),
			env,
			ctx,
		);
		expect(store.size).toBe(0);
	});
});
