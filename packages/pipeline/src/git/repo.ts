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

import type { CommitInfo } from "../models.ts";
import { formatCommitMessage } from "./message.ts";

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
			env: { ...process.env, ...env },
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
				env: { ...process.env, ...env },
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
		}
	}

	writeAndAdd(relPath: string, content: string): boolean {
		const filePath = join(this.path, relPath);
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

		// Clamp dates to valid git range
		let gitDate = info.authorDate;
		if (gitDate < "1970-01-02") {
			gitDate = "1970-01-02";
		} else if (gitDate > "2099-12-31") {
			gitDate = "2099-12-31";
		}
		const authorDate = `${gitDate}T00:00:00`;

		const commitEnv = {
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

		try {
			const output = await this.runWithOutput([
				"log",
				"--all",
				"--format=%B%x00",
			]).catch(() => "");

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
		} catch {
			// Empty repo, no commits yet
		}
	}

	hasCommitWithSourceId(sourceId: string, normId?: string): boolean {
		if (!this.existingCommits) {
			throw new Error("Call loadExistingCommits() first");
		}

		if (normId === undefined) {
			for (const key of this.existingCommits) {
				if (key.startsWith(`${sourceId}|`)) return true;
			}
			return false;
		}

		return this.existingCommits.has(`${sourceId}|${normId}`);
	}

	async log(format = "%ai  %s", reverse = true): Promise<string> {
		const args = ["log", `--format=${format}`];
		if (reverse) args.push("--reverse");
		return this.runWithOutput(args).catch(() => "");
	}
}
