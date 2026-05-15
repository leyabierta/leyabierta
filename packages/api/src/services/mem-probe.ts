/**
 * RSS pressure probe vs cgroup memory cap.
 *
 * Reads /proc/self/status every 30 seconds and compares VmRSS against the
 * cgroup memory limit. Logs a structured JSON line to stderr so we know
 * before the kernel OOM-kills the process.
 *
 * macOS / non-Linux: logs once and disables itself — production observability
 * only, dev doesn't need it.
 */

import { existsSync, readFileSync } from "node:fs";

/** One reading emitted to stderr. */
export interface MemProbeReading {
	probe: "mem";
	level: "info" | "warn" | "critical";
	rss_mb: number;
	cap_mb: number;
	ratio: number;
	vm_peak_gb: number;
}

/** Returns null if the file does not exist or the key is missing. */
function readProcStatusKb(key: string): number | null {
	try {
		const text = readFileSync("/proc/self/status", "utf8");
		const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text);
		return match ? Number(match[1]) : null;
	} catch {
		return null;
	}
}

/** Reads the cgroup v2 limit first, falls back to v1. Returns bytes or null. */
function readCgroupLimitBytes(): number | null {
	const v2Path = "/sys/fs/cgroup/memory.max";
	const v1Path = "/sys/fs/cgroup/memory/memory.limit_in_bytes";
	for (const p of [v2Path, v1Path]) {
		try {
			const raw = readFileSync(p, "utf8").trim();
			// cgroup v2 may return "max" when there is no limit
			if (raw === "max" || raw === "") continue;
			const n = Number(raw);
			if (Number.isFinite(n) && n > 0) return n;
		} catch {
			/* not found */
		}
	}
	return null;
}

function levelFor(ratio: number): MemProbeReading["level"] {
	if (ratio >= 0.85) return "critical";
	if (ratio >= 0.7) return "warn";
	return "info";
}

/**
 * Starts the in-process RSS pressure probe.
 *
 * - Runs every 30 seconds via setInterval (unref'd so it doesn't block exit).
 * - Suppresses output when idle (ratio < 0.3 for 5 consecutive readings).
 * - No-ops silently on macOS/non-Linux.
 */
export function startMemProbe(): void {
	// Guard: /proc/self/status must exist (Linux only)
	if (!existsSync("/proc/self/status")) {
		process.stderr.write("[mem-probe] rss probe disabled (non-Linux)\n");
		return;
	}

	const cgroupLimitBytes = readCgroupLimitBytes();
	if (cgroupLimitBytes === null) {
		process.stderr.write(
			"[mem-probe] cgroup memory limit not readable — probe disabled\n",
		);
		return;
	}

	const capMb = cgroupLimitBytes / (1024 * 1024);

	// Consecutive idle-reading counter (ratio < 0.3)
	let idleStreak = 0;
	const IDLE_THRESHOLD = 0.3;
	const IDLE_SKIP_AFTER = 5; // suppress after 5 consecutive idle readings

	const timer = setInterval(() => {
		const rssKb = readProcStatusKb("VmRSS");
		const peakKb = readProcStatusKb("VmPeak");

		if (rssKb === null) return; // /proc went away (shouldn't happen but guard it)

		const rssMb = rssKb / 1024;
		const vmPeakGb = peakKb !== null ? peakKb / (1024 * 1024) : 0;
		const ratio = rssMb / capMb;

		if (ratio < IDLE_THRESHOLD) {
			idleStreak++;
			// Only emit every IDLE_SKIP_AFTER intervals when consistently idle
			if (idleStreak < IDLE_SKIP_AFTER) return;
			idleStreak = 0; // reset so we wait another 5 before the next idle log
		} else {
			idleStreak = 0; // busy — always log
		}

		const reading: MemProbeReading = {
			probe: "mem",
			level: levelFor(ratio),
			rss_mb: Math.round(rssMb),
			cap_mb: Math.round(capMb),
			ratio: Math.round(ratio * 1000) / 1000,
			vm_peak_gb: Math.round(vmPeakGb * 100) / 100,
		};

		process.stderr.write(`${JSON.stringify(reading)}\n`);
	}, 30_000);

	// Don't keep the event loop alive on graceful shutdown
	timer.unref();
}
