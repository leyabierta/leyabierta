/**
 * scripts/daily-pipeline.sh --watch — the 15-minute fast pass.
 *
 * Runs the real script in a temp sandbox (LEYABIERTA_SELF_UPDATED=1, env-
 * overridden paths) with a fake `docker` first on PATH that records its argv
 * and returns canned `boe-watch` output. `flock` is faked too (macOS has none):
 * it only honours FAKE_FLOCK_BUSY for -n / -w.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "daily-pipeline.sh");

const FAKE_DOCKER = `#!/bin/bash
echo "$*" >> "$DOCKER_LOG"
case "$*" in
  *"boe-watch check"*)
    if [ -n "\${CHECK_FAIL:-}" ]; then exit 1; fi
    echo "\${CHECK_JSON:-}" ;;
  *"boe-watch should-push"*)
    if [ -n "\${SHOULD_PUSH_JSON:-}" ]; then echo "$SHOULD_PUSH_JSON"; else echo '{"push":false,"reason":"none"}'; fi ;;
  *"rev-list --count origin/main..HEAD"*) echo 1 ;;
  *"rev-list --count HEAD..origin/main"*) echo 0 ;;
  *"rev-parse HEAD"*) echo abc123 ;;
esac
exit 0
`;

const FAKE_FLOCK = `#!/bin/bash
if [ -n "\${FLOCK_LOG:-}" ]; then echo "$*" >> "$FLOCK_LOG"; fi
if [ -n "\${FAKE_FLOCK_BUSY:-}" ]; then exit 1; fi
exit 0
`;

let dir: string;
let log: string;
let dockerLog: string;
let failures: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "daily-pipeline-watch-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	mkdirSync(join(dir, "logs"));
	writeFileSync(join(bin, "docker"), FAKE_DOCKER);
	writeFileSync(join(bin, "flock"), FAKE_FLOCK);
	chmodSync(join(bin, "docker"), 0o755);
	chmodSync(join(bin, "flock"), 0o755);
	writeFileSync(join(dir, "env"), "LEYES_PUSH_TOKEN=tok\n");
	log = join(dir, "logs", "fast-pass.log");
	dockerLog = join(dir, "docker.log");
	failures = join(dir, "logs", ".watch-failures");
	writeFileSync(dockerLog, "");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(
	extra: Record<string, string> = {},
	args = ["--watch"],
	script = SCRIPT,
) {
	const proc = Bun.spawnSync(["bash", script, ...args], {
		env: {
			...process.env,
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			LEYABIERTA_SELF_UPDATED: "1",
			SELF_UPDATE_LOCK: join(dir, "self-update.lock"),
			LOG: log,
			LOCKFILE: join(dir, "lock"),
			REPO_DIR: join(dir, "repo"),
			ENV_FILE: join(dir, "env"),
			CONTAINER: "test-api",
			DOCKER_LOG: dockerLog,
			PUSH_RETRY_SLEEP: "0",
			ALERT_WEBHOOK_URL: "",
			...extra,
		},
	});
	return proc.exitCode;
}

const calls = () =>
	readFileSync(dockerLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => l.replace(/^exec (-e \S+ )?test-api /, ""));
const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

const CHANGED = JSON.stringify({
	changed: true,
	latest: "20260930T134843Z",
	ids: ["BOE-A-2026-1", "BOE-A-2026-2"],
	newIds: ["BOE-A-2026-2"],
});

test("script parses", () => {
	expect(Bun.spawnSync(["bash", "-n", SCRIPT]).exitCode).toBe(0);
});

describe("--watch", () => {
	test("no change and nothing pending: no steps, no push, quiet log", () => {
		expect(run({ CHECK_JSON: '{"changed":false,"ids":[],"newIds":[]}' })).toBe(
			0,
		);
		expect(calls()).toEqual([
			"bun run --silent boe-watch check",
			"bun run --silent boe-watch should-push",
		]);
		expect(logText().trim()).toBe("");
	});

	test("change: steps run in order, --ids and --new, no Step 10", () => {
		expect(run({ CHECK_JSON: CHANGED })).toBe(0);
		const c = calls();
		const idx = (needle: string) => c.findIndex((l) => l.includes(needle));
		const order = [
			"boe-watch check",
			"pipeline bootstrap",
			"bun run ingest",
			"ingest-analisis --ids BOE-A-2026-1,BOE-A-2026-2",
			"embed-corpus",
			"generate-reform-summaries",
			"generate-citizen-tags",
			"generate-omnibus-topics",
			"generate-og-images",
			"wal_checkpoint",
			"boe-watch commit --latest 20260930T134843Z --new",
			"boe-watch should-push",
		].map(idx);
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(c.some((l) => l.includes("rebuild-vector-index"))).toBe(false);
		expect(c.some((l) => l.includes("download-auxiliar"))).toBe(false);
		expect(c.some((l) => l.includes("boe-watch pushed"))).toBe(false);
	});

	test("commit has no --new without new laws", () => {
		run({
			CHECK_JSON: JSON.stringify({
				changed: true,
				latest: "L1",
				ids: ["A"],
				newIds: [],
			}),
		});
		const commit = calls().find((l) => l.includes("boe-watch commit"));
		expect(commit).toBe("bun run boe-watch commit --latest L1");
	});

	test("failed ingest aborts before commit", () => {
		// The fake fails for nothing by default; make `bun run ingest` fail.
		const bin = join(dir, "bin", "docker");
		writeFileSync(
			bin,
			FAKE_DOCKER.replace(
				'case "$*" in',
				'case "$*" in\n  *"bun run ingest"*) exit 3 ;;',
			),
		);
		const code = run({ CHECK_JSON: CHANGED });
		expect(code).toBe(3);
		expect(calls().some((l) => l.includes("boe-watch commit"))).toBe(false);
		expect(logText()).toContain("watch (fast pass) aborted early");
	});

	test("should-push true: pushes leyes then records it", () => {
		expect(
			run({
				CHECK_JSON: '{"changed":false,"ids":[],"newIds":[]}',
				SHOULD_PUSH_JSON: '{"push":true,"reason":"pending"}',
			}),
		).toBe(0);
		const c = calls();
		expect(c.some((l) => l.includes("push origin main"))).toBe(true);
		expect(c[c.length - 1]).toBe("bun run boe-watch pushed");
	});

	test("lock held: exits 0 without doing anything", () => {
		expect(run({ FAKE_FLOCK_BUSY: "1", CHECK_JSON: CHANGED })).toBe(0);
		expect(calls()).toEqual([]);
		expect(logText()).toContain("another pipeline run is in progress");
	});

	test("check failing: no steps, failure counter increments, resets on success", () => {
		expect(run({ CHECK_FAIL: "1" })).toBe(0);
		expect(run({ CHECK_FAIL: "1" })).toBe(0);
		expect(readFileSync(failures, "utf8").trim()).toBe("2");
		expect(calls().every((l) => l.includes("boe-watch check"))).toBe(true);
		expect(run({ CHECK_JSON: '{"changed":false,"ids":[],"newIds":[]}' })).toBe(
			0,
		);
		expect(existsSync(failures)).toBe(false);
	});
});

describe("nightly run", () => {
	test("waits for the lock and alerts instead of silently skipping", () => {
		const logNightly = join(dir, "logs", "daily-pipeline.log");
		const code = run({ FAKE_FLOCK_BUSY: "1", LOG: logNightly }, []);
		expect(code).toBe(1);
		expect(readFileSync(logNightly, "utf8")).toContain("nightly run skipped");
	});
});

describe("self-update", () => {
	const git = (cwd: string, ...args: string[]) => {
		const r = Bun.spawnSync(["git", ...args], {
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	};

	test("a stale copy re-execs the prod-tag script under the self-update lock, keeping --watch", () => {
		// origin: a commit with the current script, tagged prod.
		const origin = join(dir, "origin");
		mkdirSync(join(origin, "scripts"), { recursive: true });
		writeFileSync(
			join(origin, "scripts", "daily-pipeline.sh"),
			readFileSync(SCRIPT),
		);
		chmodSync(join(origin, "scripts", "daily-pipeline.sh"), 0o755);
		git(origin, "init", "-q");
		git(origin, "add", ".");
		git(origin, "commit", "-qm", "prod");
		git(origin, "tag", "prod");
		git(dir, "clone", "-q", origin, "repo");

		// The on-disk copy cron runs is older than the one at refs/tags/prod.
		const stale = join(dir, "stale-daily-pipeline.sh");
		writeFileSync(stale, `${readFileSync(SCRIPT, "utf8")}\n# stale\n`);
		const flockLog = join(dir, "flock.log");

		const code = run(
			{
				LEYABIERTA_SELF_UPDATED: "",
				FLOCK_LOG: flockLog,
				CHECK_JSON: '{"changed":false,"ids":[],"newIds":[]}',
			},
			["--watch"],
			stale,
		);
		expect(code).toBe(0);
		expect(logText()).toContain("re-exec'ing");
		expect(logText()).not.toContain("self-update failed");
		// The re-exec'd script ran in watch mode, not a full pipeline.
		expect(calls()).toEqual([
			"bun run --silent boe-watch check",
			"bun run --silent boe-watch should-push",
		]);
		// Self-update lock (fd 8) first, then the pipeline lock (fd 9).
		expect(readFileSync(flockLog, "utf8").trim().split("\n")).toEqual([
			"-w 120 8",
			"-n 9",
		]);
	});
});
