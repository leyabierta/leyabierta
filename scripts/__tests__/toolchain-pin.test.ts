/**
 * The Bun version is a single number that has to hold in three places at once:
 * package.json (read by setup-bun in CI), the Dockerfile (the API runtime), and
 * the lockfile that both consume. When those drift, the failure never looks like
 * a version problem — it looks like an unrelated test breaking, or
 * `--frozen-lockfile` refusing a lockfile nobody touched.
 *
 * It has happened twice:
 *   - 2026-05-12 (#91): image on `1-slim` resolved to 1.3.11, lockfile written
 *     by 1.3.13 -> frozen-lockfile aborted the Deploy.
 *   - 2026-08-21: workflows on `bun-version: latest` picked up Bun 1.4.0 the
 *     morning it shipped, which changed `process.env.X = undefined` from
 *     deleting the key to storing the string "undefined". The daily deploy of
 *     the legislation went red on an analytics test.
 *
 * Both times the pin was fixed only in the layer that hurt. These tests make the
 * drift itself the failure, so it surfaces in a PR instead of at 06:31 in the
 * deploy that publishes new laws.
 */

import { describe, expect, test } from "bun:test";

const ROOT = new URL("../../", import.meta.url).pathname;

const pkg = await Bun.file(`${ROOT}package.json`).json();
const dockerfile = await Bun.file(`${ROOT}Dockerfile`).text();

describe("Bun version pin", () => {
	// setup-bun parses this field as `packageManager.split("bun@")[1]` and then
	// validates it strictly. A Corepack-style hash suffix (`bun@1.3.14+sha512.…`)
	// survives that split, fails validation, and the action falls back to
	// `latest` — silently restoring the exact behaviour this pin exists to stop.
	// The pin is fail-open, so the format is the thing worth guarding.
	test("package.json declares an exact version with no hash suffix", () => {
		expect(pkg.packageManager).toMatch(/^bun@\d+\.\d+\.\d+$/);
	});

	test("every Dockerfile stage uses the version from package.json", () => {
		const version = pkg.packageManager.split("bun@")[1];
		const tags = [...dockerfile.matchAll(/^FROM\s+oven\/bun:(\S+)/gm)].map(
			(m) => m[1],
		);

		expect(tags.length).toBeGreaterThan(0);
		for (const tag of tags) {
			expect(tag).toBe(`${version}-slim`);
		}
	});
});

describe("CI workflows", () => {
	test("no workflow tracks a floating Bun version", async () => {
		const dir = `${ROOT}.github/workflows`;
		const offenders: string[] = [];

		for (const name of Array.from(
			new Bun.Glob("*.yml").scanSync({ cwd: dir }),
		)) {
			const body = await Bun.file(`${dir}/${name}`).text();
			// `latest`, `1`, `1.3` — anything that can resolve to a version the
			// lockfile and the image have never seen.
			for (const [, value] of body.matchAll(/^\s*bun-version:\s*(\S+)/gm)) {
				if (value && !/^\d+\.\d+\.\d+$/.test(value)) {
					offenders.push(`${name}: ${value}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
