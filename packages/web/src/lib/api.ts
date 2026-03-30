/**
 * API client for fetching data from Elysia API.
 */

const API_BASE = import.meta.env.API_URL ?? "http://localhost:3000";

async function fetchApi<T>(path: string): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`);
	if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
	return res.json();
}

export interface Law {
	id: string;
	title: string;
	short_title: string;
	country: string;
	rank: string;
	published_at: string;
	updated_at: string | null;
	status: string;
	department: string;
	source_url: string;
}

export interface Reform {
	norm_id: string;
	date: string;
	source_id: string;
	affected_blocks: string[];
}

export interface BlockSummary {
	block_id: string;
	block_type: string;
	title: string;
	position: number;
	current_text: string;
}

export interface LawDetail extends Law {
	reforms: Reform[];
	blocks: BlockSummary[];
}

export interface SearchResult {
	data: Law[];
	total: number;
	limit: number;
	offset: number;
}

export interface DiffResult {
	id: string;
	from: string;
	to: string;
	diff: string;
}

export interface VersionResult {
	id: string;
	date: string;
	content: string;
}

export function searchLaws(
	params: Record<string, string>,
): Promise<SearchResult> {
	const qs = new URLSearchParams(params).toString();
	return fetchApi(`/v1/laws?${qs}`);
}

export function getLaw(id: string): Promise<LawDetail> {
	return fetchApi(`/v1/laws/${id}`);
}

export function getLawVersion(
	id: string,
	date: string,
): Promise<VersionResult> {
	return fetchApi(`/v1/laws/${id}/versions/${date}`);
}

export function getLawDiff(
	id: string,
	from: string,
	to: string,
): Promise<DiffResult> {
	return fetchApi(`/v1/laws/${id}/diff?from=${from}&to=${to}`);
}

export function getRanks(): Promise<{
	data: Array<{ rank: string; count: number }>;
}> {
	return fetchApi("/v1/ranks");
}

export function getMaterias(): Promise<{
	data: Array<{ materia: string; count: number }>;
}> {
	return fetchApi("/v1/materias");
}

export interface AnalisisResult {
	id: string;
	materias: string[];
	notas: string[];
	referencias: {
		anteriores: Array<{ relation: string; normId: string; text: string }>;
		posteriores: Array<{ relation: string; normId: string; text: string }>;
	};
}

export function getLawAnalisis(id: string): Promise<AnalisisResult> {
	return fetchApi(`/v1/laws/${id}/analisis`);
}
