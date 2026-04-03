/**
 * API client for fetching data from Elysia API.
 */

const API_BASE = import.meta.env.API_URL ?? "https://api.leyabierta.es";

async function fetchApi<T>(path: string, retries = 3): Promise<T> {
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const res = await fetch(`${API_BASE}${path}`);
			if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
			return res.json();
		} catch (err) {
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

// ── Digest endpoints ──

export interface DigestProfileSummary {
	profile_id: string;
	name: string;
	icon: string;
	description: string;
	digest_count: number;
	latest_week: string;
}

export function getDigestProfiles(): Promise<{
	data: DigestProfileSummary[];
}> {
	return fetchApi("/v1/digests/profiles");
}

export interface DigestWeekSummary {
	week: string;
	summary: string;
	generated_at: string;
	reform_count: number;
}

export function getProfileDigests(profileId: string): Promise<{
	profile: Profile | null;
	data: DigestWeekSummary[];
}> {
	return fetchApi(`/v1/digests/${profileId}`);
}

export interface DigestReform {
	id: string;
	title: string;
	rank: string;
	date: string;
	source_id: string;
	relevant: boolean | null;
	te_afecta_porque: string;
	headline: string;
	summary: string;
}

export interface DigestDetail {
	week: string;
	profile: { id: string; name: string; icon: string; description: string };
	jurisdiction: string;
	summary: string;
	generated_at: string;
	reforms: DigestReform[];
}

export function getDigest(
	profileId: string,
	week: string,
): Promise<DigestDetail> {
	return fetchApi(`/v1/digests/${profileId}/${week}`);
}

export interface PersonalDigestResult {
	reforms: DigestReform[];
	profiles: string[];
	week_range: string;
}

export function getPersonalDigest(
	profiles: string[],
	jurisdiccion = "es",
	weeks = 4,
): Promise<PersonalDigestResult> {
	return fetchApi(
		`/v1/digests/personal?profiles=${profiles.join(",")}&jurisdiccion=${jurisdiccion}&weeks=${weeks}`,
	);
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
