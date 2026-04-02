/**
 * Git service for retrieving law versions and computing diffs.
 *
 * Operates on the leyes git repo where each reform is a commit.
 *
 * NOTE: Git does not support dates before 1970-01-01 (Unix epoch).
 * Commits for pre-1970 legislation have their git date clamped to
 * 1970-01-02, but carry the real date in the Source-Date trailer.
 * All date-based lookups use Source-Date trailers to handle this
 * correctly.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Monotonic counter for temp file names. */
let tmpSeq = 0;

type CommitInfo = {
	sha: string;
	date: string;
	subject: string;
	sourceId: string;
};

export class GitService {
	/** Cache of commit lists per file path. Commits are immutable (historical reforms). */
	private commitCache = new Map<
		string,
		{ commits: CommitInfo[]; ts: number }
	>();
	private static CACHE_TTL = 60 * 60 * 1000; // 1 hour

	constructor(private repoPath: string) {}

	/**
	 * Run a git command and capture stdout reliably.
	 * Tries Bun.spawn first, falls back to shell redirect.
	 */
	private async git(args: string[]): Promise<string> {
		// Try Bun.spawn first
		try {
			const proc = Bun.spawn(["git", ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, _, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode === 0 && stdout) return stdout;
		} catch {
			// Fall through
		}

		// Fallback: shell with file redirect
		return this.gitShell(args);
	}

	/**
	 * Run a git command via shell with file-redirect output capture.
	 * Reliable in all environments including bun test runner.
	 */
	private gitShell(args: string[]): string {
		const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
		const id = ++tmpSeq;
		const outFile = join(tmpdir(), `.git-svc-out-${process.pid}-${id}`);
		const errFile = join(tmpdir(), `.git-svc-err-${process.pid}-${id}`);

		try {
			execSync(`git ${quoted} > '${outFile}' 2> '${errFile}'`, {
				shell: "/bin/bash",
			});
			return existsSync(outFile) ? readFileSync(outFile, "utf-8") : "";
		} catch {
			return "";
		} finally {
			try {
				unlinkSync(outFile);
			} catch {}
			try {
				unlinkSync(errFile);
			} catch {}
		}
	}

	/**
	 * Run a git command that may return non-zero exit code (like git diff).
	 */
	private async gitNothrow(args: string[]): Promise<string> {
		// Try Bun.spawn first
		try {
			const proc = Bun.spawn(["git", ...args], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (stdout) return stdout;
		} catch {
			// Fall through
		}

		// Fallback: shell with file redirect (nothrow)
		return this.gitShell(args);
	}

	/**
	 * Get all commits for a file with their real (trailer) dates.
	 * Returns newest-first (git log default order).
	 * Results are cached for 1 hour since reform history is immutable.
	 */
	private async getCommitsForFile(filePath: string): Promise<CommitInfo[]> {
		const cached = this.commitCache.get(filePath);
		if (cached && Date.now() - cached.ts < GitService.CACHE_TTL) {
			return cached.commits;
		}

		const commits = await this.fetchCommitsForFile(filePath);
		this.commitCache.set(filePath, { commits, ts: Date.now() });
		return commits;
	}

	private async fetchCommitsForFile(filePath: string): Promise<CommitInfo[]> {
		try {
			const SEP = "\x1f"; // ASCII unit separator — field delimiter
			// Use %x1e (record separator) + literal marker as record boundary.
			// %(trailers) appends trailing newlines that break naive \n splitting,
			// so we delimit records with a marker and strip embedded newlines.
			const REC_MARKER = "\x1e\x1e\x1e";
			const format = `%H${SEP}%aI${SEP}%s${SEP}%(trailers:key=Source-Date,valueonly)${SEP}%(trailers:key=Source-Id,valueonly)%x1e%x1e%x1e`;

			const raw = await this.git([
				"-C",
				this.repoPath,
				"log",
				`--format=${format}`,
				"--",
				filePath,
			]);

			return raw
				.split(REC_MARKER)
				.map((record) => record.replace(/\n/g, "").trim())
				.filter(Boolean)
				.map((record) => {
					const [
						sha = "",
						authorDate = "",
						subject = "",
						sourceDate = "",
						sourceId = "",
					] = record.split(SEP);
					return {
						sha: sha.trim(),
						// Prefer Source-Date trailer (real date), fall back to git author date
						date: sourceDate.trim() || authorDate.trim().slice(0, 10),
						subject: subject.trim(),
						sourceId: sourceId.trim(),
					};
				});
		} catch {
			return [];
		}
	}

	/**
	 * Get the content of a file at a specific date by finding
	 * the last commit on or before that date.
	 *
	 * Uses Source-Date trailers instead of git dates to correctly
	 * handle pre-1970 legislation.
	 */
	async getFileAtDate(filePath: string, date: string): Promise<string | null> {
		try {
			const commits = await this.getCommitsForFile(filePath);
			// Commits are newest-first; find the first one whose date <= requested date
			const match = commits.find((c) => c.date <= date);
			if (!match) return null;

			const content = await this.git([
				"-C",
				this.repoPath,
				"show",
				`${match.sha}:${filePath}`,
			]);
			return content || null;
		} catch {
			return null;
		}
	}

	/**
	 * Get the current (latest) content of a file.
	 */
	async getFileLatest(filePath: string): Promise<string | null> {
		try {
			const content = await this.git([
				"-C",
				this.repoPath,
				"show",
				`HEAD:${filePath}`,
			]);
			return content || null;
		} catch {
			return null;
		}
	}

	/**
	 * Compute a unified diff between two dates for a file.
	 *
	 * Uses Source-Date trailers instead of git dates to correctly
	 * handle pre-1970 legislation.
	 */
	async diff(
		filePath: string,
		fromDate: string,
		toDate: string,
	): Promise<string | null> {
		try {
			const commits = await this.getCommitsForFile(filePath);

			const fromCommit = commits.find((c) => c.date <= fromDate);
			const toCommit = commits.find((c) => c.date <= toDate);

			if (!fromCommit || !toCommit) return null;
			if (fromCommit.sha === toCommit.sha) return "";

			// git diff returns exit code 1 when there are differences, which is not an error
			const result = await this.gitNothrow([
				"-C",
				this.repoPath,
				"diff",
				fromCommit.sha,
				toCommit.sha,
				"--",
				filePath,
			]);
			return result;
		} catch {
			return null;
		}
	}

	/**
	 * Get the commit log for a file (reform history).
	 *
	 * Returns real legislation dates from Source-Date trailers,
	 * not git commit dates (which are clamped to 1970 for pre-epoch laws).
	 */
	async log(
		filePath: string,
		limit = 50,
	): Promise<
		Array<{ sha: string; date: string; subject: string; sourceId: string }>
	> {
		const commits = await this.getCommitsForFile(filePath);
		return commits.slice(0, limit);
	}
}
