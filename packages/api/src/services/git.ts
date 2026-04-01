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

import { $ } from "bun";

export class GitService {
	constructor(private repoPath: string) {}

	/**
	 * Get all commits for a file with their real (trailer) dates.
	 * Returns newest-first (git log default order).
	 */
	private async getCommitsForFile(
		filePath: string,
	): Promise<
		Array<{ sha: string; date: string; subject: string; sourceId: string }>
	> {
		try {
			const SEP = "\x1f"; // ASCII unit separator — field delimiter
			// Use %x1e (record separator) + literal marker as record boundary.
			// %(trailers) appends trailing newlines that break naive \n splitting,
			// so we delimit records with a marker and strip embedded newlines.
			const REC_MARKER = "\x1e\x1e\x1e";
			const format = `%H${SEP}%aI${SEP}%s${SEP}%(trailers:key=Source-Date,valueonly)${SEP}%(trailers:key=Source-Id,valueonly)%x1e%x1e%x1e`;
			const proc = Bun.spawn(
				[
					"git",
					"-C",
					this.repoPath,
					"log",
					`--format=${format}`,
					"--",
					filePath,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const raw = await new Response(proc.stdout).text();
			await proc.exited;

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

			return await $`git -C ${this.repoPath} show ${match.sha}:${filePath}`.text();
		} catch {
			return null;
		}
	}

	/**
	 * Get the current (latest) content of a file.
	 */
	async getFileLatest(filePath: string): Promise<string | null> {
		try {
			return await $`git -C ${this.repoPath} show HEAD:${filePath}`.text();
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
			const result =
				await $`git -C ${this.repoPath} diff ${fromCommit.sha} ${toCommit.sha} -- ${filePath}`
					.nothrow()
					.text();
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
