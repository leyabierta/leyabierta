/**
 * API client for fetching data from Elysia API.
 */

const API_BASE = import.meta.env.PUBLIC_API_URL ?? "https://api.leyabierta.es";
const API_KEY = import.meta.env.API_BYPASS_KEY ?? "";

async function fetchApi<T>(path: string, retries = 3): Promise<T> {
	const headers: Record<string, string> = {};
	if (API_KEY) headers["x-api-key"] = API_KEY;

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${API_BASE}${path}`, { headers });
			if (!res.ok) {
				// Don't retry client errors (4xx) — they won't succeed on retry
				if (res.status >= 400 && res.status < 500) {
					throw new Error(`API ${res.status}: ${path}`);
				}
				throw new Error(`API ${res.status}: ${path} (retryable)`);
			}
			return res.json();
		} catch (err) {
			const isRetryable =
				err instanceof Error && err.message.includes("(retryable)");
			const isNetworkError =
				err instanceof TypeError || // fetch network failures
				(err instanceof Error && !err.message.startsWith("API "));
			if (!isRetryable && !isNetworkError) throw err;
			if (attempt === retries) throw err;
			const delay = attempt * 2000;
			console.warn(
				`[api] ${path} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`,
			);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw new Error(`unreachable`);
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
	citizen_summary: string;
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
	citizen_tags: string[];
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

export function getCitizenTags(
	limit?: number,
): Promise<{ data: Array<{ tag: string; count: number }> }> {
	const qs = limit ? `?limit=${limit}` : "";
	return fetchApi(`/v1/citizen-tags${qs}`);
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

export interface AnomalyItem {
	type?: string;
	norm_id: string;
	title: string;
	date?: string;
	source_id?: string;
	block_id?: string;
	block_type?: string;
	materia?: string;
	id?: string;
	source_url?: string;
}

export interface AnomaliesResult {
	futureDates: AnomalyItem[];
	emptyBlocks: AnomalyItem[];
	unresolvedMaterias: AnomalyItem[];
	missingEli: AnomalyItem[];
}

export function getAnomalies(): Promise<AnomaliesResult> {
	return fetchApi("/v1/anomalias");
}

export interface Stats {
	norms: number;
	articles: number;
	versions: number;
	reforms: number;
	categories: number;
	oldest: string;
	newest: string;
}

export interface MostReformedLaw {
	id: string;
	title: string;
	rank: string;
	reform_count: number;
}

export interface Jurisdiction {
	jurisdiction: string;
	count: number;
}

export interface RecentReform {
	norm_id: string;
	date: string;
	source_id: string;
	title: string;
}

export function getStats(): Promise<Stats> {
	return fetchApi("/v1/stats");
}

export function getMostReformed(): Promise<{ data: MostReformedLaw[] }> {
	return fetchApi("/v1/most-reformed");
}

export function getJurisdictions(): Promise<{ data: Jurisdiction[] }> {
	return fetchApi("/v1/jurisdictions");
}

export function getRecentReforms(): Promise<{ data: RecentReform[] }> {
	return fetchApi("/v1/recent-reforms");
}

// ── Alert/newsletter endpoints ──

export interface Profile {
	id: string;
	name: string;
	description: string;
	icon: string;
}

export function getProfiles(): Promise<{ data: Profile[] }> {
	return fetchApi("/v1/profiles");
}

export interface PersonalReformsResult {
	reforms: Array<{
		id: string;
		title: string;
		rank: string;
		status: string;
		date: string;
		source_id: string;
	}>;
	materias: string[];
	date_range: string;
}

export function getPersonalReforms(
	materias: string[],
	jurisdiccion = "es",
	weeks = 4,
): Promise<PersonalReformsResult> {
	return fetchApi(
		`/v1/reforms/personal?materias=${encodeURIComponent(materias.join(","))}&jurisdiccion=${jurisdiccion}&weeks=${weeks}`,
	);
}

export async function subscribe(
	email: string,
	profileId: string,
	jurisdiction: string,
): Promise<{ ok?: boolean; error?: string; message?: string }> {
	const res = await fetch(`${API_BASE}/v1/alerts/subscribe`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, profileId, jurisdiction }),
	});
	return res.json();
}

export async function confirmSubscription(
	token: string,
): Promise<{ ok?: boolean; error?: string; message?: string }> {
	const res = await fetch(`${API_BASE}/v1/alerts/confirm/${token}`);
	return res.json();
}

export async function cancelSubscription(
	token: string,
): Promise<{ ok?: boolean; error?: string; message?: string }> {
	const res = await fetch(`${API_BASE}/v1/alerts/unsubscribe/${token}`);
	return res.json();
}

// ── Omnibus endpoints ──

export interface OmnibusTopic {
	topic_label: string;
	article_count: number;
	headline: string;
	summary: string;
	is_sneaked: number;
	block_ids: string[];
}

export interface OmnibusDetail {
	id: string;
	title: string;
	rank: string;
	materia_count: number;
	topic_count: number;
	sneaked_count: number;
	latest_reform_date: string | null;
	topics: OmnibusTopic[];
}

export async function getOmnibusDetail(
	normId: string,
): Promise<OmnibusDetail | null> {
	try {
		return await fetchApi(`/v1/omnibus/${normId}`, 1);
	} catch {
		return null;
	}
}
