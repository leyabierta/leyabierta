/**
 * Digest endpoints: list profiles with digests, list weeks, get full digest.
 */

import { Elysia, t } from "elysia";
import { getProfileById } from "../data/profiles.ts";
import type { DbService } from "../services/db.ts";

export function digestRoutes(dbService: DbService) {
	return new Elysia({ prefix: "/v1/digests" })
		.get("/profiles", () => {
			const rows = dbService.listDigestProfiles();
			return {
				data: rows.map((r) => {
					const profile = getProfileById(r.profile_id);
					return {
						profile_id: r.profile_id,
						name: profile?.name ?? r.profile_id,
						icon: profile?.icon ?? "",
						description: profile?.description ?? "",
						digest_count: r.digest_count,
						latest_week: r.latest_week,
					};
				}),
			};
		})

		.get(
			"/personal",
			({ query, set }) => {
				const profilesCsv = query.profiles;
				if (!profilesCsv || profilesCsv.trim() === "") {
					set.status = 400;
					return { error: "profiles query parameter is required" };
				}

				const weeks = query.weeks ? Math.min(Number(query.weeks), 12) : 4;
				if (weeks <= 0 || Number.isNaN(weeks)) {
					set.status = 400;
					return { error: "weeks must be a positive number (max 12)" };
				}

				const profileIds = profilesCsv
					.split(",")
					.map((p) => p.trim())
					.filter((p) => p.length > 0);
				if (profileIds.length === 0) {
					set.status = 400;
					return { error: "profiles query parameter is required" };
				}

				const seenIds = new Set<string>();
				const merged: Array<{
					id: string;
					title: string;
					rank: string;
					date: string;
					source_id: string;
					relevant: boolean;
					te_afecta_porque: string;
					headline: string;
					summary: string;
				}> = [];
				const allWeeks: string[] = [];

				for (const pid of profileIds) {
					const rows = dbService.getRecentDigests(pid, weeks);
					for (const row of rows) {
						if (!allWeeks.includes(row.week)) {
							allWeeks.push(row.week);
						}
						try {
							const parsed = JSON.parse(row.data);
							const reforms = Array.isArray(parsed.reforms)
								? parsed.reforms
								: [];
							for (const r of reforms) {
								const rid = r.id ?? r.norm_id;
								if (rid && !seenIds.has(rid)) {
									seenIds.add(rid);
									merged.push({
										id: rid,
										title: r.title ?? "",
										rank: r.rank ?? "",
										date: r.date ?? "",
										source_id: r.source_id ?? "",
										relevant: r.relevant ?? true,
										te_afecta_porque: r.te_afecta_porque ?? "",
										headline: r.headline ?? "",
										summary: r.summary ?? "",
									});
								}
							}
						} catch {
							// Skip malformed JSON
						}
					}
				}

				// Sort by date descending
				merged.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

				// Compute week range
				allWeeks.sort();
				const weekRange =
					allWeeks.length > 0
						? `${allWeeks[0]} to ${allWeeks[allWeeks.length - 1]}`
						: "";

				return {
					reforms: merged,
					profiles: profileIds,
					week_range: weekRange,
				};
			},
			{
				query: t.Object({
					profiles: t.Optional(t.String()),
					jurisdiccion: t.Optional(t.String()),
					weeks: t.Optional(t.String()),
				}),
			},
		)

		.get(
			"/:profileId",
			({ params }) => {
				const weeks = dbService.listDigestsForProfile(params.profileId);
				const profile = getProfileById(params.profileId);
				return {
					profile: profile
						? {
								id: profile.id,
								name: profile.name,
								icon: profile.icon,
								description: profile.description,
							}
						: null,
					data: weeks,
				};
			},
			{
				params: t.Object({ profileId: t.String() }),
			},
		)

		.get(
			"/:profileId/:week",
			({ params, set }) => {
				const digest = dbService.getDigest(params.profileId, params.week);
				if (!digest) {
					set.status = 404;
					return { error: "Digest not found" };
				}

				const profile = getProfileById(params.profileId);
				let reforms: unknown[] = [];
				try {
					const parsed = JSON.parse(digest.data);
					reforms = parsed.reforms ?? [];
				} catch {
					// malformed JSON
				}

				return {
					week: digest.week,
					profile: profile
						? {
								id: profile.id,
								name: profile.name,
								icon: profile.icon,
								description: profile.description,
							}
						: {
								id: params.profileId,
								name: params.profileId,
								icon: "",
								description: "",
							},
					jurisdiction: digest.jurisdiction,
					summary: digest.summary,
					generated_at: digest.generated_at,
					reforms,
				};
			},
			{
				params: t.Object({
					profileId: t.String(),
					week: t.String(),
				}),
			},
		);
}
