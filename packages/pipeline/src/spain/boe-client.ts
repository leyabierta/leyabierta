/**
 * HTTP client for the BOE (Boletín Oficial del Estado) open data API.
 *
 * Base: https://www.boe.es/datosabiertos/api/
 * No authentication required. Self-imposed courtesy delay between requests.
 */

import type { LegislativeClient } from "../country.ts";
import { withRetry } from "../utils/retry.ts";

const BASE_URL = "https://www.boe.es/datosabiertos/api";
const DEFAULT_DELAY_MS = 200; // ~5 req/s courtesy limit

export class BoeClient implements LegislativeClient {
	private lastRequestAt = 0;

	constructor(private readonly delayMs = DEFAULT_DELAY_MS) {}

	async getText(normId: string): Promise<Uint8Array> {
		const url = `${BASE_URL}/legislacion-consolidada/id/${normId}/texto`;
		return this.fetch(url, "application/xml");
	}

	async getMetadata(normId: string): Promise<Uint8Array> {
		const url = `${BASE_URL}/legislacion-consolidada/id/${normId}/metadatos`;
		return this.fetch(url, "application/json");
	}

	async getAnalisis(normId: string): Promise<BoeAnalisis> {
		const url = `${BASE_URL}/legislacion-consolidada/id/${normId}/analisis`;
		const bytes = await this.fetch(url, "application/json");
		const json = JSON.parse(new TextDecoder().decode(bytes));
		if (json.status?.code !== "200") {
			return {
				materias: [],
				notas: [],
				referencias: { anteriores: [], posteriores: [] },
			};
		}
		const data = json.data?.[0];
		if (!data) {
			return {
				materias: [],
				notas: [],
				referencias: { anteriores: [], posteriores: [] },
			};
		}
		return {
			materias: toArray(data.materias).map((m: Record<string, unknown>) => {
				const materia = m.materia as Record<string, unknown> | undefined;
				return (materia?.texto as string) ?? "";
			}),
			notas: extractNotas(data.notas),
			referencias: {
				anteriores: flattenRefs(
					toArray(data.referencias?.anteriores),
					"anterior",
				),
				posteriores: flattenRefs(
					toArray(data.referencias?.posteriores),
					"posterior",
				),
			},
		};
	}

	/**
	 * Extract materia codes from the ELI meta tags in the consolidated HTML.
	 * The /analisis endpoint only returns a subset — the HTML has all of them.
	 */
	async getMateriaCodes(normId: string): Promise<string[]> {
		const url = `https://www.boe.es/buscar/act.php?id=${normId}`;
		try {
			await this.throttle();
			const res = await globalThis.fetch(url);
			if (!res.ok) return [];
			const html = await res.text();
			const codes: string[] = [];
			const re =
				/resource="https:\/\/www\.boe\.es\/legislacion\/eli\/materias\/(\d+)"/g;
			let match: RegExpExecArray | null;
			const seen = new Set<string>();
			while ((match = re.exec(html)) !== null) {
				if (!seen.has(match[1]!)) {
					seen.add(match[1]!);
					codes.push(match[1]!);
				}
			}
			return codes;
		} catch {
			return [];
		}
	}

	async close(): Promise<void> {
		// No persistent connections to clean up
	}

	/**
	 * List consolidated norms with pagination.
	 * Returns the raw JSON response with `status` and `data` fields.
	 *
	 * The API returns results ordered by fecha_actualizacion DESC by default.
	 * No sort parameter is passed — we rely on this default ordering for
	 * the early-stop logic in discoverUpdated().
	 */
	async list(
		limit: number,
		offset = 0,
	): Promise<{ data: BoeListItem[]; total?: number }> {
		const url = `${BASE_URL}/legislacion-consolidada?limit=${limit}&offset=${offset}`;
		const bytes = await this.fetch(url, "application/json");
		const json = JSON.parse(new TextDecoder().decode(bytes));

		if (json.status?.code !== "200") {
			throw new Error(`BOE list failed: ${json.status?.text}`);
		}

		return { data: json.data ?? [] };
	}

	private async fetch(url: string, accept: string): Promise<Uint8Array> {
		return withRetry(
			async () => {
				await this.throttle();

				const response = await globalThis.fetch(url, {
					headers: { Accept: accept },
				});

				if (!response.ok) {
					throw new Error(`BOE request failed: ${response.status} ${url}`);
				}

				return new Uint8Array(await response.arrayBuffer());
			},
			{
				maxRetries: 3,
				baseDelayMs: 1000,
				onRetry: (attempt, error) => {
					const msg = error instanceof Error ? error.message : String(error);
					console.warn(`  ⟳ Retry ${attempt}/3 for ${url}: ${msg}`);
				},
			},
		);
	}

	private async throttle(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastRequestAt;
		if (elapsed < this.delayMs) {
			await new Promise((resolve) =>
				setTimeout(resolve, this.delayMs - elapsed),
			);
		}
		this.lastRequestAt = Date.now();
	}
}

/** Normalize BOE API values that can be object, array, or empty. */
function toArray(val: unknown): Record<string, unknown>[] {
	if (Array.isArray(val)) return val as Record<string, unknown>[];
	if (val && typeof val === "object" && Object.keys(val).length > 0)
		return [val as Record<string, unknown>];
	return [];
}

/** Extract notas — can be [{nota: [...]}, ...] or {nota: "..."} */
function extractNotas(raw: unknown): string[] {
	if (!raw) return [];
	const items = toArray(raw);
	const result: string[] = [];
	for (const item of items) {
		const nota = item?.nota;
		if (typeof nota === "string") {
			result.push(nota);
		} else if (Array.isArray(nota)) {
			for (const n of nota) {
				if (typeof n === "string") result.push(n);
			}
		}
	}
	return result;
}

function flattenRefs(
	groups: Record<string, unknown>[],
	key: string,
): BoeReference[] {
	const refs: BoeReference[] = [];
	for (const group of groups) {
		const items = toArray(group[key]);
		for (const ref of items) {
			const relacion = ref.relacion as Record<string, unknown> | undefined;
			refs.push({
				relation: (relacion?.texto as string) ?? "",
				normId: (ref.id_norma as string) ?? "",
				text: (ref.texto as string) ?? "",
			});
		}
	}
	return refs;
}

export interface BoeReference {
	relation: string;
	normId: string;
	text: string;
}

export interface BoeAnalisis {
	materias: string[];
	notas: string[];
	referencias: {
		anteriores: BoeReference[];
		posteriores: BoeReference[];
	};
}

/** Shape of a single item in the BOE list response. */
export interface BoeListItem {
	identificador: string;
	titulo: string;
	rango: { codigo: string; texto: string };
	departamento: { codigo: string; texto: string };
	fecha_publicacion: string; // YYYYMMDD
	fecha_disposicion: string; // YYYYMMDD
	fecha_vigencia?: string;
	fecha_actualizacion?: string; // ISO timestamp, e.g. "20260408T080417Z"
	estatus_derogacion?: string; // "S" | "N" | null
	vigencia_agotada?: string; // "S" | "N"
	estado_consolidacion?: { codigo: string; texto: string };
	url_eli?: string;
	url_html_consolidada?: string;
}
