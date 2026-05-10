/**
 * Progress file writer for long `generate` runs.
 *
 * Writes a compact JSON snapshot of pipeline progress so a separate `watch`
 * process can render a live dashboard without tail-following the noisy log.
 *
 * Writes are atomic (tmp + rename) and never throw — a write error is
 * logged once and swallowed, because monitoring must never crash the pipeline.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PipelineStats } from "../pipeline.ts";

export interface ProgressLastAccepted {
	id: string;
	voice: string;
	materia: string;
	jurisdiction: string;
	question: string;
}

export interface ProgressLastBorderline {
	id: string;
	votes: string;
	question: string;
}

export interface ProgressFile {
	startedAt: string;
	updatedAt: string;
	target: number;
	maxSeeds: number;
	seedsTried: number;
	draftsGenerated: number;
	accepted: number;
	borderline: number;
	droppedAtLeak: number;
	droppedAtAnswerability: number;
	droppedAtCritic: number;
	droppedAtJudges: number;
	droppedAtDedup: number;
	droppedAtError: number;
	acceptanceRate: number;
	elapsedSec: number;
	etaSec: number | null;
	lastAccepted?: ProgressLastAccepted;
	lastBorderline?: ProgressLastBorderline;
	done: boolean;
	finalStats?: PipelineStats;
}

export interface ProgressWriterOptions {
	target: number;
	maxSeeds: number;
	/** Primary path, e.g. `.../pilot/progress-<stamp>.json`. */
	primaryPath: string;
	/** Stable latest path, e.g. `.../datasets/.progress.json`. */
	latestPath: string;
	/** Wall-clock interval between forced flushes, ms. Default 5000. */
	intervalMs?: number;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}

function atomicWriteJson(path: string, data: unknown): void {
	const tmp = `${path}.tmp`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`);
	renameSync(tmp, path);
}

/**
 * Classify a pipeline `onRejected` reason string into a drop-bucket.
 * Reason strings are produced by `packages/eval/src/pipeline.ts`.
 */
export function classifyRejectReason(
	reason: string,
): keyof Pick<
	PipelineStats,
	| "droppedAtLeak"
	| "droppedAtAnswerability"
	| "droppedAtCritic"
	| "droppedAtJudges"
	| "droppedAtDedup"
	| "droppedAtError"
> {
	if (reason.startsWith("leak:")) return "droppedAtLeak";
	if (reason.startsWith("unanswerable:")) return "droppedAtAnswerability";
	if (reason.startsWith("voice critic")) return "droppedAtCritic";
	if (reason.startsWith("judges rejected")) return "droppedAtJudges";
	if (reason === "duplicate") return "droppedAtDedup";
	return "droppedAtError";
}

export interface ProgressWriter {
	recordAccepted(q: {
		id: string;
		voice: string;
		materia: string;
		jurisdiction: string;
		question: string;
	}): void;
	recordBorderline(e: {
		id: string;
		acceptVotes: number;
		rejectVotes: number;
		question: string;
	}): void;
	recordRejected(reason: string): void;
	/** Finalize: set `done: true`, write final snapshot, stop timer. */
	finalize(finalStats: PipelineStats): void;
	/** Stop the periodic flush timer without writing. */
	stop(): void;
}

export function makeProgressWriter(
	opts: ProgressWriterOptions,
): ProgressWriter {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const intervalMs = opts.intervalMs ?? 5000;

	const stats: PipelineStats = {
		seedsTried: 0,
		draftsGenerated: 0,
		droppedAtLeak: 0,
		droppedAtAnswerability: 0,
		droppedAtCritic: 0,
		droppedAtJudges: 0,
		droppedAtDedup: 0,
		droppedAtError: 0,
		accepted: 0,
		borderline: 0,
	};

	let lastAccepted: ProgressLastAccepted | undefined;
	let lastBorderline: ProgressLastBorderline | undefined;
	let done = false;
	let finalStats: PipelineStats | undefined;
	let warned = false;

	function build(): ProgressFile {
		const nowMs = Date.now();
		const elapsedSec = (nowMs - startedAtMs) / 1000;
		const acceptanceRate =
			stats.draftsGenerated > 0 ? stats.accepted / stats.draftsGenerated : 0;
		const rate = stats.accepted / Math.max(elapsedSec, 1);
		const remaining = Math.max(opts.target - stats.accepted, 0);
		const etaSec = rate > 0 ? remaining / rate : null;
		return {
			startedAt,
			updatedAt: new Date(nowMs).toISOString(),
			target: opts.target,
			maxSeeds: opts.maxSeeds,
			seedsTried: stats.seedsTried,
			draftsGenerated: stats.draftsGenerated,
			accepted: stats.accepted,
			borderline: stats.borderline,
			droppedAtLeak: stats.droppedAtLeak,
			droppedAtAnswerability: stats.droppedAtAnswerability,
			droppedAtCritic: stats.droppedAtCritic,
			droppedAtJudges: stats.droppedAtJudges,
			droppedAtDedup: stats.droppedAtDedup,
			droppedAtError: stats.droppedAtError,
			acceptanceRate,
			elapsedSec,
			etaSec,
			lastAccepted,
			lastBorderline,
			done,
			finalStats,
		};
	}

	function write(): void {
		try {
			const snapshot = build();
			atomicWriteJson(opts.primaryPath, snapshot);
			atomicWriteJson(opts.latestPath, snapshot);
		} catch (err) {
			if (!warned) {
				warned = true;
				console.warn(
					`[progress] write failed (subsequent errors suppressed): ${(err as Error).message}`,
				);
			}
		}
	}

	// Initial snapshot so `watch` finds the file right away.
	write();

	const timer = setInterval(write, intervalMs);
	if (typeof (timer as { unref?: () => void }).unref === "function") {
		(timer as { unref: () => void }).unref();
	}

	return {
		recordAccepted(q) {
			stats.accepted++;
			// Seeds/drafts aren't directly observable from callbacks; drafts is
			// at least accepted + all rejections we've seen. Close enough for
			// acceptance-rate display — `finalize` fills in the true numbers.
			stats.draftsGenerated++;
			lastAccepted = {
				id: q.id,
				voice: q.voice,
				materia: q.materia,
				jurisdiction: q.jurisdiction,
				question: truncate(q.question, 120),
			};
			write();
		},
		recordBorderline(e) {
			stats.borderline++;
			lastBorderline = {
				id: e.id,
				votes: `${e.acceptVotes}-${e.rejectVotes}`,
				question: truncate(e.question, 120),
			};
			write();
		},
		recordRejected(reason) {
			const bucket = classifyRejectReason(reason);
			stats[bucket]++;
			stats.draftsGenerated++;
			write();
		},
		finalize(fs) {
			// Replace approximate counters with the true ones from the pipeline.
			Object.assign(stats, fs);
			done = true;
			finalStats = fs;
			write();
			clearInterval(timer);
		},
		stop() {
			clearInterval(timer);
		},
	};
}
