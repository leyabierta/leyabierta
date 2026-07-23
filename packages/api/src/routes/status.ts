/**
 * GET /v1/status — corpus freshness (issue #129).
 *
 * Public, cacheable endpoint so the frontend can honestly communicate the
 * BOE-consolidated-legislation lag instead of letting "Cambios recientes"
 * look abandoned when the source has simply gone quiet for a stretch.
 */

import { Elysia } from "elysia";
import type { StatusService } from "../services/status.ts";

export function statusRoutes(statusService: StatusService) {
	return new Elysia({ prefix: "/v1" }).get(
		"/status",
		({ set }) => {
			// Cache at the edge for 5 min — cheap aggregate queries, but no
			// need to recompute on every request. Independent of the general
			// s-maxage=3600 default in index.ts: freshness data is exactly the
			// kind of thing we don't want stale for an hour.
			set.headers["Cache-Control"] =
				"public, max-age=0, s-maxage=300, must-revalidate";
			return statusService.getStatus();
		},
		{
			detail: {
				summary: "Corpus freshness status",
				description:
					"Reports how fresh the ingested corpus is: total norms/reforms, " +
					"the most recent reform date actually in the database (excluding " +
					"implausible/corrupt dates), and days elapsed since it. Exists " +
					"because Ley Abierta only ingests BOE-consolidated legislation, " +
					"which lags the daily bulletin by 1-2 weeks — this endpoint lets " +
					"clients communicate that lag instead of it reading as a stalled " +
					"or broken site. `last_sync` is best-effort (see " +
					"`last_sync_source`): there is currently no fully reliable " +
					"'pipeline last ran' heartbeat for nights where the BOE published " +
					"nothing new.",
				tags: ["Sistema"],
			},
		},
	);
}
