/**
 * Git operations for the legislation output repo.
 *
 * Uses Bun.spawn for full control over GIT_AUTHOR_DATE, with
 * file-based fallbacks for reading output (works around Bun.spawn
 * pipe capture returning empty in some environments like bun test).
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Monotonic counter to avoid temp file collisions across concurrent calls. */
let tmpSeq = 0;

/**
 * Git env vars that leak from parent processes (e.g., lefthook hooks)
 * and must be stripped so child git commands target the correct repo.
 */
const GIT_LEAK_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/** Return a copy of process.env with leaked git vars removed. */
function cleanEnv(extra?: Record<string, string>): Record<string, string> {
	const env = { ...process.env, ...extra } as Record<string, string>;
	for (const key of GIT_LEAK_VARS) delete env[key];
	return env;
}

import type { CommitInfo } from "../models.ts";
import { formatCommitMessage } from "./message.ts";

/**
 * All known Spanish ELI jurisdiction folders in the leyes repo.
 * Used by writeAndAdd to detect cross-jurisdiction duplicates.
 */
const SPAIN_JURISDICTIONS = [
	"es",
	"es-an",
	"es-ar",
	"es-as",
	"es-cb",
	"es-cl",
	"es-cm",
	"es-cn",
	"es-ct",
	"es-ex",
	"es-ga",
	"es-ib",
	"es-mc",
	"es-md",
	"es-nc",
	"es-pv",
	"es-ri",
	"es-vc",
] as const;

/** Regex that matches `<jurisdiction>/<normId>.md` paths. */
const NORM_PATH_RE = /^(es(?:-[a-z]{2})?)\/([A-Z][^/]+)\.md$/;

export class GitRepo {
	private existingCommits: Set<string> | null = null;

	constructor(
		private readonly path: string,
		private readonly committerName: string,
		private readonly committerEmail: string,
	) {}

	/**
	 * Run a git command via Bun.spawn.
	 * Side effects (file writes, commits) work correctly,
	 * but stdout capture may return empty in bun test runner.
	 */
	private async run(
		args: string[],
		env?: Record<string, string>,
	): Promise<string> {
		const proc = Bun.spawn(["git", ...args], {
			cwd: this.path,
			env: cleanEnv(env),
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		if (exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
		}

		return stdout.trim();
	}

	/**
	 * Run a git command and reliably capture its output.
	 * Uses shell redirection to a temp file as fallback when
	 * Bun.spawn pipe capture returns empty.
	 */
	private async runWithOutput(
		args: string[],
		env?: Record<string, string>,
	): Promise<string> {
		// Try Bun.spawn first (fastest path)
		try {
			const result = await this.run(args, env);
			if (result) return result;
		} catch {
			// Fall through to shell-based approach
		}

		// Fallback: use shell with file redirect
		return this.runShell(args, env);
	}

	/**
	 * Shell-based git execution with file-redirect output capture.
	 * Reliable in all environments including bun test runner.
	 */
	private runShell(args: string[], env?: Record<string, string>): string {
		const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
		const id = ++tmpSeq;
		const outFile = join(tmpdir(), `.git-cmd-out-${process.pid}-${id}`);
		const errFile = join(tmpdir(), `.git-cmd-err-${process.pid}-${id}`);

		// Build env export prefix for the shell command
		const envPrefix = Object.entries(env ?? {})
			.map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`)
			.join(" && ");
		const envCmd = envPrefix ? `${envPrefix} && ` : "";

		try {
			execSync(`${envCmd}git ${quoted} > '${outFile}' 2> '${errFile}'`, {
				cwd: this.path,
				env: cleanEnv(env),
				shell: "/bin/bash",
			});
			return existsSync(outFile) ? readFileSync(outFile, "utf-8").trim() : "";
		} catch {
			const stderr = existsSync(errFile)
				? readFileSync(errFile, "utf-8").trim()
				: "";
			throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
		} finally {
			try {
				unlinkSync(outFile);
			} catch {}
			try {
				unlinkSync(errFile);
			} catch {}
		}
	}

	async init(): Promise<void> {
		mkdirSync(this.path, { recursive: true });

		if (!existsSync(join(this.path, ".git"))) {
			await this.run(["init"]);
			await this.run(["config", "user.name", this.committerName]);
			await this.run(["config", "user.email", this.committerEmail]);
			// Disable hooks in generated repos to avoid inheriting parent hooks
			await this.run(["config", "core.hooksPath", "/dev/null"]);
		}
	}

	writeAndAdd(relPath: string, content: string): boolean {
		const filePath = join(this.path, relPath);

		// ── Pre-write invariant: same norm ID must not exist in another
		// jurisdiction folder. Skipped when relPath already exists — that path
		// is the canonical location for this norm and an update there is fine
		// even if a stale duplicate sits in another folder (the operator can
		// clean that up separately without blocking legitimate updates).
		if (!existsSync(filePath)) {
			const match = NORM_PATH_RE.exec(relPath);
			if (match) {
				const jurisdiction = match[1]!;
				const normId = match[2]!;
				for (const other of SPAIN_JURISDICTIONS) {
					if (other === jurisdiction) continue;
					const candidate = join(this.path, other, `${normId}.md`);
					if (existsSync(candidate)) {
						const otherRel = `${other}/${normId}.md`;
						throw new Error(
							`Refusing to write ${relPath}: same id "${normId}" already exists at ${candidate}. ` +
								`A norm must live in exactly one jurisdiction folder. ` +
								`To resolve, decide which is canonical and remove the other: ` +
								`git -C ${this.path} rm ${otherRel}  (or)  git -C ${this.path} rm ${relPath}`,
						);
					}
				}
			}
		}

		mkdirSync(dirname(filePath), { recursive: true });

		if (existsSync(filePath)) {
			const existing = readFileSync(filePath, "utf-8");
			if (existing === content) return false;
		}

		writeFileSync(filePath, content, "utf-8");
		// We'll add in the next step
		return true;
	}

	async add(relPath: string): Promise<void> {
		await this.run(["add", relPath]);
	}

	async commit(info: CommitInfo, allowEmpty = false): Promise<string | null> {
		// Use runWithOutput to reliably capture status
		const status = await this.runWithOutput(["status", "--porcelain"]);
		if (!status && !allowEmpty) return null;

		const message = formatCommitMessage(info);

		// Validate the date BEFORE clamping. Empty/malformed dates are an
		// upstream bug and silently clamping them to 1970-01-02 buries the
		// problem — we end up with junk commit dates that look intentional.
		// Refuse to commit with no date; the caller must supply something.
		const sourceId = info.trailers["Source-Id"] ?? "<no-source-id>";
		const normId = info.trailers["Norm-Id"] ?? "<no-norm-id>";
		if (!info.authorDate || !/^\d{4}-\d{2}-\d{2}$/.test(info.authorDate)) {
			throw new Error(
				`Refusing to commit with invalid date "${info.authorDate}" ` +
					`(Source-Id=${sourceId}, Norm-Id=${normId}). ` +
					`Fix the upstream parser instead of clamping silently.`,
			);
		}

		// Clamp to git's safe range. Some downstream tools (web build, GitHub
		// UI) behave poorly on pre-1970 timestamps. Anything we clamp gets
		// logged so we can audit which commits had real ancient dates vs which
		// had a fallback like "1900-01-01" (the BOE metadata sentinel for
		// missing data).
		let gitDate = info.authorDate;
		if (gitDate < "1970-01-02") {
			console.warn(
				`[git.commit] Clamping pre-1970 date ${gitDate} → 1970-01-02 ` +
					`(Source-Id=${sourceId}, Norm-Id=${normId})`,
			);
			gitDate = "1970-01-02";
		} else if (gitDate > "2099-12-31") {
			console.warn(
				`[git.commit] Clamping post-2099 date ${gitDate} → 2099-12-31 ` +
					`(Source-Id=${sourceId}, Norm-Id=${normId})`,
			);
			gitDate = "2099-12-31";
		}
		// Always use explicit UTC offset (+00:00) so the stored TZ is
		// deterministic regardless of the host system's local timezone
		// (e.g., Europe/Madrid alternates between CET +0100 and CEST +0200).
		// Midday (12:00:00Z) survives any DST crossover without risk of
		// shifting the calendar date.
		const authorDate = `${gitDate}T12:00:00+00:00`;

		const commitEnv = {
			TZ: "UTC",
			GIT_AUTHOR_DATE: authorDate,
			GIT_COMMITTER_DATE: authorDate,
			GIT_AUTHOR_NAME: info.authorName,
			GIT_AUTHOR_EMAIL: info.authorEmail,
		};

		const commitArgs = ["-c", "commit.gpgsign=false", "commit"];
		if (!status) commitArgs.push("--allow-empty");
		commitArgs.push("-m", message);

		// Try Bun.spawn first; fall back to file-based commit if it fails
		try {
			await this.run(commitArgs, commitEnv);
		} catch {
			// Use -F (file) instead of -m to avoid shell escaping issues
			const msgFile = join(
				tmpdir(),
				`.git-commit-msg-${process.pid}-${++tmpSeq}`,
			);
			writeFileSync(msgFile, message, "utf-8");
			try {
				const fileArgs = ["-c", "commit.gpgsign=false", "commit"];
				if (!status) fileArgs.push("--allow-empty");
				fileArgs.push("-F", msgFile);
				this.runShell(fileArgs, commitEnv);
			} finally {
				try {
					unlinkSync(msgFile);
				} catch {}
			}
		}

		// Read HEAD SHA reliably
		let sha: string | null;
		try {
			sha = await this.runWithOutput(["rev-parse", "HEAD"]);
		} catch {
			sha = this.readHeadSha();
		}

		// Update in-memory cache
		if (this.existingCommits) {
			const sourceId = info.trailers["Source-Id"] ?? "";
			const normId = info.trailers["Norm-Id"] ?? "";
			if (sourceId && normId) {
				this.existingCommits.add(`${sourceId}|${normId}`);
			}
		}

		return sha || null;
	}

	/**
	 * Read HEAD SHA directly from git ref files.
	 */
	private readHeadSha(): string | null {
		try {
			const headContent = readFileSync(
				join(this.path, ".git", "HEAD"),
				"utf-8",
			).trim();

			if (headContent.startsWith("ref: ")) {
				const refPath = join(this.path, ".git", headContent.slice(5));
				if (existsSync(refPath)) {
					return readFileSync(refPath, "utf-8").trim();
				}
				return null;
			}

			return headContent;
		} catch {
			return null;
		}
	}

	async loadExistingCommits(): Promise<void> {
		this.existingCommits = new Set();

		let output = "";
		try {
			output = await this.runWithOutput(["log", "--all", "--format=%B%x00"]);
		} catch (err) {
			// Empty repo OR git/pipe failure. Leaving the cache empty is safe —
			// hasCommitWithSourceId falls back to per-commit `git log --grep` —
			// but we surface the failure so silent degradation doesn't hide a
			// real problem (e.g. Bun pipe capture failure on large repos).
			console.warn(
				`[git/repo] loadExistingCommits failed: ${(err as Error).message}. Idempotency checks will fall back to per-commit git-grep.`,
			);
			return;
		}

		if (!output.trim()) return;

		for (const body of output.split("\0")) {
			let sourceId = "";
			let normId = "";
			for (const line of body.split("\n")) {
				if (line.startsWith("Source-Id: ")) {
					sourceId = line.slice("Source-Id: ".length).trim();
				} else if (line.startsWith("Norm-Id: ")) {
					normId = line.slice("Norm-Id: ".length).trim();
				}
			}
			if (sourceId && normId) {
				this.existingCommits.add(`${sourceId}|${normId}`);
			}
		}

		// Sanity: if the repo has commits but we parsed zero trailers, warn.
		// Indicates either the output capture lost data, or commits predate the
		// trailer convention. Either way, idempotency falls back to git-grep.
		if (this.existingCommits.size === 0) {
			console.warn(
				"[git/repo] loadExistingCommits: parsed 0 trailers from non-empty git output. Idempotency falls back to git-grep.",
			);
		}
	}

	/**
	 * Check whether a commit with the given Source-Id (and optionally Norm-Id)
	 * already exists in the repo.
	 *
	 * Uses `git log --grep` on the Source-Id trailer so the lookup is
	 * TZ-independent and works even when the in-memory cache was not loaded or
	 * was partially populated due to a large repo / output-capture issue.
	 *
	 * Fast path: if the in-memory cache from `loadExistingCommits()` is present,
	 * a cache-hit is returned immediately without shelling out. A cache-miss
	 * still falls through to git grep to guard against stale / incomplete caches.
	 */
	async hasCommitWithSourceId(
		sourceId: string,
		normId?: string,
	): Promise<boolean> {
		// ── Fast path: in-memory cache hit ───────────────────────────────────
		if (this.existingCommits) {
			let hit: boolean;
			if (normId === undefined) {
				hit = [...this.existingCommits].some((k) =>
					k.startsWith(`${sourceId}|`),
				);
			} else {
				hit = this.existingCommits.has(`${sourceId}|${normId}`);
			}
			if (hit) return true;
			// Cache miss — fall through to git grep for correctness.
			// The cache may be incomplete (e.g. large repo, pipe capture failure).
		}

		// ── Authoritative path: git log --grep on Source-Id trailer ──────────
		// Escape the id so it cannot inject regex metacharacters.
		// BOE ids are "BOE-A-1978-31229" (alphanumeric + hyphens) but we escape
		// defensively for any future id format.
		const escapedId = sourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const grepPattern = `^Source-Id: ${escapedId}$`;

		try {
			const result = await this.runWithOutput([
				"log",
				"--all",
				`--grep=${grepPattern}`,
				"--extended-regexp",
				"--format=%H",
				"-1",
			]);
			if (!result.trim()) return false;

			// If normId is specified, verify the matching commit also has the
			// correct Norm-Id trailer. Anchored to line boundaries to prevent
			// prefix collisions: "Norm-Id: BOE-A-2025-76" must NOT match a
			// body containing "Norm-Id: BOE-A-2025-7659".
			if (normId !== undefined) {
				const sha = result.trim().split("\n")[0]!;
				const body = await this.runWithOutput([
					"show",
					"-s",
					"--format=%B",
					sha,
				]);
				const escapedNormId = normId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				return new RegExp(`^Norm-Id: ${escapedNormId}$`, "m").test(body);
			}

			return true;
		} catch {
			// Empty repo or git error — treat as not found
			return false;
		}
	}

	async log(format = "%ai  %s", reverse = true): Promise<string> {
		const args = ["log", `--format=${format}`];
		if (reverse) args.push("--reverse");
		return this.runWithOutput(args).catch(() => "");
	}
}
