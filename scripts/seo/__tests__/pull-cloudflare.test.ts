// Cloudflare's Workers Analytics dataset returns one row per adaptively-sized
// time bucket, not pre-grouped by day — this guards the client-side grouping
// that turns those buckets into the daily series the snapshot exposes.
import { describe, expect, test } from "bun:test";
import { groupWorkerByDay } from "../pull-cloudflare.ts";

function row(datetime: string, requests: number, errors = 0) {
	return {
		dimensions: { datetime },
		sum: { requests, errors, subrequests: 0 },
	};
}

describe("groupWorkerByDay", () => {
	test("sums buckets that fall on the same day", () => {
		const rows = [
			row("2026-09-19T03:00:00Z", 100, 1),
			row("2026-09-19T14:00:00Z", 200, 0),
			row("2026-09-20T01:00:00Z", 50, 2),
		];
		expect(groupWorkerByDay(rows)).toEqual([
			{ date: "2026-09-19", requests: 300, errors: 1 },
			{ date: "2026-09-20", requests: 50, errors: 2 },
		]);
	});

	test("returns days sorted ascending regardless of input order", () => {
		const rows = [
			row("2026-09-20T01:00:00Z", 1),
			row("2026-09-18T01:00:00Z", 2),
		];
		expect(groupWorkerByDay(rows).map((d) => d.date)).toEqual([
			"2026-09-18",
			"2026-09-20",
		]);
	});

	test("empty input yields an empty series", () => {
		expect(groupWorkerByDay([])).toEqual([]);
	});
});
