/**
 * BOE change watcher CLI. Prints exactly one JSON line to stdout; logs go to
 * stderr.
 *
 *   boe-watch check [--state P] [--db P] [--max-pages N]
 *   boe-watch commit --latest <fecha> [--new] [--state P]
 *   boe-watch should-push [--state P] [--min-interval-min N]
 *   boe-watch pushed [--state P]
 */

import {
	check,
	commit,
	defaultStatePath,
	markPushed,
	shouldPush,
} from "./boe-watch.ts";
import { BoeClient } from "./spain/boe-client.ts";

function flag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
}

/** A NaN here would silently stop the watcher (no pages read, never push). */
function positiveInt(name: string, raw: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error(`${name} must be a positive integer, got "${raw}"`);
	}
	return n;
}

async function main() {
	const argv = process.argv.slice(3);
	const sub = process.argv[2];
	const dbPath =
		flag(argv, "--db") ?? process.env.DB_PATH ?? "./data/leyabierta.db";
	const statePath = flag(argv, "--state") ?? defaultStatePath(dbPath);

	let out: unknown;
	switch (sub) {
		case "check":
			out = await check({
				statePath,
				dbPath,
				client: new BoeClient(),
				maxPages: positiveInt("--max-pages", flag(argv, "--max-pages") ?? "10"),
			});
			break;
		case "commit": {
			const latest = flag(argv, "--latest");
			if (!latest) throw new Error("commit requires --latest <fecha>");
			out = commit({ statePath, latest, isNew: argv.includes("--new") });
			break;
		}
		case "should-push":
			out = shouldPush({
				statePath,
				minIntervalMin: positiveInt(
					"--min-interval-min",
					flag(argv, "--min-interval-min") ??
						process.env.WATCH_PUSH_MIN_INTERVAL_MIN ??
						"60",
				),
			});
			break;
		case "pushed":
			out = markPushed({ statePath });
			break;
		default:
			throw new Error(
				"usage: boe-watch <check|commit|should-push|pushed> [options]",
			);
	}
	console.log(JSON.stringify(out));
}

main().catch((err) => {
	console.error(`[boe-watch] ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
