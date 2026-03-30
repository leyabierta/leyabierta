/**
 * Git service for retrieving law versions and computing diffs.
 *
 * Operates on the output/es git repo where each reform is a commit.
 */

import { $ } from "bun";

export class GitService {
	constructor(private repoPath: string) {}

	/**
	 * Get the content of a file at a specific date by finding
	 * the last commit before that date.
	 */
	async getFileAtDate(filePath: string, date: string): Promise<string | null> {
		try {
			const result =
				await $`git -C ${this.repoPath} log --before=${date}T23:59:59 --format=%H -1 -- ${filePath}`.text();
			const sha = result.trim();
			if (!sha) return null;

			return await $`git -C ${this.repoPath} show ${sha}:${filePath}`.text();
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
	 */
	async diff(
		filePath: string,
		fromDate: string,
		toDate: string,
	): Promise<string | null> {
		try {
			const fromSha =
				await $`git -C ${this.repoPath} log --before=${fromDate}T23:59:59 --format=%H -1 -- ${filePath}`.text();
			const toSha =
				await $`git -C ${this.repoPath} log --before=${toDate}T23:59:59 --format=%H -1 -- ${filePath}`.text();

			const from = fromSha.trim();
			const to = toSha.trim();

			if (!from || !to) return null;
			if (from === to) return "";

			// git diff returns exit code 1 when there are differences, which is not an error
			const result =
				await $`git -C ${this.repoPath} diff ${from} ${to} -- ${filePath}`
					.nothrow()
					.text();
			return result;
		} catch {
			return null;
		}
	}

	/**
	 * Get the commit log for a file (reform history).
	 */
	async log(
		filePath: string,
		limit = 50,
	): Promise<
		Array<{ sha: string; date: string; subject: string; sourceId: string }>
	> {
		try {
			const raw =
				await $`git -C ${this.repoPath} log --format=%H|%aI|%s|%(trailers:key=Source-Id,valueonly) -n ${limit} -- ${filePath}`.text();

			return raw
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [sha = "", date = "", subject = "", sourceId = ""] =
						line.split("|");
					return {
						sha: sha.trim(),
						date: date.trim(),
						subject: subject.trim(),
						sourceId: sourceId.trim(),
					};
				});
		} catch {
			return [];
		}
	}
}
