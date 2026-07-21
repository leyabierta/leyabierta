#!/usr/bin/env bun
// Pull on-site behavior from the self-hosted Umami (read-only, straight from its
// Postgres). Complements GSC: which landing pages engage, where visitors come
// from, what utm campaigns bring traffic.
//
//   bun run scripts/seo/pull-umami.ts            # on KonarServer (docker exec)
//   SEO_UMAMI_ARGV='["ssh","KonarServer","docker","exec","-i","code-umami-db-1","psql","-U","umami","-d","umami"]' \
//     bun run scripts/seo/pull-umami.ts          # off-server, via ssh
//
// Writes data/seo/umami-<date>.json and refreshes data/seo/umami-latest.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, today, type UmamiSnapshot, UMAMI_WEBSITE_ID, umamiQuery } from "./lib.ts";

const WINDOW_DAYS = Number(process.env.SEO_UMAMI_WINDOW_DAYS ?? 28);
const W = UMAMI_WEBSITE_ID;
const since = `now() - interval '${WINDOW_DAYS} days'`;

// event_type = 1 → pageview. Own referrers and empties are excluded so
// `referrers` reflects real external sources (organic, social, links).
function main() {
	const num = (v: string | undefined) => Number(v ?? 0);

	const totalsRow = umamiQuery(
		`select count(*) filter (where event_type = 1), count(distinct session_id)
		 from website_event where website_id = '${W}' and created_at > ${since};`,
	)[0];
	const totals = { pageviews: num(totalsRow?.[0]), sessions: num(totalsRow?.[1]) };

	const topPages = umamiQuery(
		`select url_path, count(*) from website_event
		 where website_id = '${W}' and event_type = 1 and created_at > ${since}
		 group by url_path order by 2 desc limit 40;`,
	).map(([path, n]) => ({ path: path ?? "", views: num(n) }));

	// First pageview per visit = entry page.
	const entryPages = umamiQuery(
		`select url_path, count(*) from (
		   select distinct on (visit_id) url_path
		   from website_event
		   where website_id = '${W}' and event_type = 1 and created_at > ${since}
		   order by visit_id, created_at asc
		 ) e group by url_path order by 2 desc limit 25;`,
	).map(([path, n]) => ({ path: path ?? "", entries: num(n) }));

	const referrers = umamiQuery(
		`select referrer_domain, count(*) from website_event
		 where website_id = '${W}' and event_type = 1 and created_at > ${since}
		   and referrer_domain is not null and referrer_domain <> ''
		   and referrer_domain not like '%leyabierta.es'
		 group by referrer_domain order by 2 desc limit 25;`,
	).map(([domain, n]) => ({ domain: domain ?? "", visits: num(n) }));

	const countries = umamiQuery(
		`select country, count(*) from session
		 where website_id = '${W}' and created_at > ${since} and country is not null
		 group by country order by 2 desc limit 15;`,
	).map(([country, n]) => ({ country: country ?? "", sessions: num(n) }));

	const utmSources = umamiQuery(
		`select utm_source, count(*) from website_event
		 where website_id = '${W}' and created_at > ${since} and utm_source is not null and utm_source <> ''
		 group by utm_source order by 2 desc limit 15;`,
	).map(([source, n]) => ({ source: source ?? "", visits: num(n) }));

	const weekly = umamiQuery(
		`select to_char(date_trunc('week', created_at), 'YYYY-MM-DD'), count(*)
		 from website_event
		 where website_id = '${W}' and event_type = 1 and created_at > now() - interval '84 days'
		 group by 1 order by 1 asc;`,
	).map(([week, n]) => ({ week: week ?? "", pageviews: num(n) }));

	const snapshot: UmamiSnapshot = {
		source: "umami",
		snapshotDate: today(),
		websiteId: W,
		windowDays: WINDOW_DAYS,
		totals,
		topPages,
		entryPages,
		referrers,
		countries,
		utmSources,
		weekly,
	};

	mkdirSync(DATA_DIR, { recursive: true });
	const dated = join(DATA_DIR, `umami-${today()}.json`);
	writeFileSync(dated, JSON.stringify(snapshot, null, 2));
	writeFileSync(join(DATA_DIR, "umami-latest.json"), JSON.stringify(snapshot, null, 2));

	console.log(
		`✓ ${dated}\n  pageviews ${totals.pageviews}  sessions ${totals.sessions}  ` +
			`top pages ${topPages.length}  referrers ${referrers.length}`,
	);
}

try {
	main();
} catch (e) {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
}
