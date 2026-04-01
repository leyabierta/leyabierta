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
