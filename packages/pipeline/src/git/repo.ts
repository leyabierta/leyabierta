/**
 * Git operations for the legislation output repo.
 *
 * Uses Bun.spawn for full control over GIT_AUTHOR_DATE.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommitInfo } from "../models.ts";
import { formatCommitMessage } from "./message.ts";

export class GitRepo {
	private existingCommits: Set<string> | null = null;

	constructor(
		private readonly path: string,
		private readonly committerName: string,
		private readonly committerEmail: string,
	) {}

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

		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
		}

		return stdout.trim();
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

	async commit(info: CommitInfo): Promise<string | null> {
		const status = await this.run(["status", "--porcelain"]);
		if (!status) return null;

		const message = formatCommitMessage(info);

		// Git doesn't accept pre-1970 dates
		let gitDate = info.authorDate;
		if (gitDate < "1970-01-02") {
			gitDate = "1970-01-02";
		}
		const authorDate = `${gitDate}T00:00:00`;

		await this.run(["-c", "commit.gpgsign=false", "commit", "-m", message], {
			GIT_AUTHOR_DATE: authorDate,
			GIT_COMMITTER_DATE: authorDate,
			GIT_AUTHOR_NAME: info.authorName,
			GIT_AUTHOR_EMAIL: info.authorEmail,
		});

		const sha = await this.run(["rev-parse", "HEAD"]);

		// Update in-memory cache
		if (this.existingCommits) {
			const sourceId = info.trailers["Source-Id"] ?? "";
			const normId = info.trailers["Norm-Id"] ?? "";
			if (sourceId && normId) {
				this.existingCommits.add(`${sourceId}|${normId}`);
			}
		}

		return sha;
	}

	async loadExistingCommits(): Promise<void> {
		this.existingCommits = new Set();

		try {
			const output = await this.run(["log", "--all", "--format=%B%x00"]).catch(
				() => "",
			);

			if (!output.trim()) return;

			for (const body of output.split("\0")) {
				let sourceId = "";
				let normId = "";
				for (const line of body.split("\n")) {
					if (line.startsWith("Source-Id: ")) {
						sourceId = line.slice("Source-Id: ".length);
					} else if (line.startsWith("Norm-Id: ")) {
						normId = line.slice("Norm-Id: ".length);
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
		return this.run(args).catch(() => "");
	}
}
