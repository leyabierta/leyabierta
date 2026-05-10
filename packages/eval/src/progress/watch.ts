/**
 * Terminal dashboard for the `generate` progress file.
 *
 * Reads `.progress.json` (or a custom path) every second, clears the screen,
 * and redraws a compact box-drawn summary. No external deps — raw ANSI only.
 *
 * Compatibility: tested on macOS Terminal, iTerm2, VS Code terminal, tmux.
 * Uses `\x1b[2J\x1b[H` (erase display + home cursor) each frame, which is
 * universally supported. We do NOT enter the alternate screen buffer: when
 * you Ctrl+C, the last frame stays visible in scrollback, which is actually
 * what you want for a long-running monitor.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { ProgressFile } from "./write.ts";

const ESC = "\x1b[";
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;

const BAR_FULL = "█";
// Eighth-block fill characters, 1/8..7/8 of a cell.
const BAR_PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export interface WatchOptions {
	file: string;
	/** Refresh interval ms. Default 1000. */
	intervalMs?: number;
	/** Consider the file stale if older than this many ms. Default 60000. */
	staleMs?: number;
	/** For tests: stop after one render. */
	once?: boolean;
}

function fmtDuration(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "—";
	const s = Math.floor(sec % 60);
	const m = Math.floor((sec / 60) % 60);
	const h = Math.floor(sec / 3600);
	if (h > 0)
		return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

function fmtEta(sec: number | null): string {
	if (sec === null || !Number.isFinite(sec)) return "—";
	if (sec < 60) return `${Math.round(sec)}s`;
	const m = Math.round(sec / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const mm = m % 60;
	return `${h}h ${String(mm).padStart(2, "0")}m`;
}

function fmtPct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

/**
 * Unicode sub-block progress bar. `width` is the number of cells.
 */
export function progressBar(fraction: number, width: number): string {
	const f = Math.max(0, Math.min(1, fraction));
	const totalEighths = Math.round(f * width * 8);
	const full = Math.floor(totalEighths / 8);
	const remainder = totalEighths % 8;
	const empty = width - full - (remainder > 0 ? 1 : 0);
	return (
		BAR_FULL.repeat(full) +
		(remainder > 0 ? BAR_PARTIAL[remainder] : "") +
		"░".repeat(Math.max(0, empty))
	);
}

function padRight(s: string, w: number): string {
	// Visible length based on code points; good enough for our content which
	// is ASCII + a few box-drawing chars we control.
	const len = [...s].length;
	if (len >= w) return s;
	return s + " ".repeat(w - len);
}

interface BoxChars {
	tl: string;
	tr: string;
	bl: string;
	br: string;
	h: string;
	v: string;
}

const FANCY_BOX: BoxChars = {
	tl: "╔",
	tr: "╗",
	bl: "╚",
	br: "╝",
	h: "═",
	v: "║",
};
const SIMPLE_BOX: BoxChars = {
	tl: "+",
	tr: "+",
	bl: "+",
	br: "+",
	h: "-",
	v: "|",
};

function buildFrame(
	p: ProgressFile | null,
	width: number,
	opts: { stale: boolean; missing: boolean },
): string {
	// Inner width = width - 2 border chars - 2 padding spaces.
	const narrow = width < 80;
	const w = Math.max(40, Math.min(width, 120));
	const inner = w - 4;
	const box = narrow ? SIMPLE_BOX : FANCY_BOX;

	const lines: string[] = [];
	const top = `${box.tl}${box.h} Ley Abierta — dataset generation ${box.h.repeat(Math.max(1, inner - " Ley Abierta — dataset generation ".length))}${box.tr}`;
	lines.push(top);

	function row(content: string): void {
		lines.push(`${box.v} ${padRight(content, inner)} ${box.v}`);
	}
	function blank(): void {
		row("");
	}

	if (opts.missing) {
		row(`${RED}⚠ progress file not found${RESET}`);
		row(`${DIM}waiting for generate to create it…${RESET}`);
		const bot = `${box.bl}${box.h.repeat(inner + 2)}${box.br}`;
		lines.push(bot);
		return lines.join("\n");
	}

	if (!p) {
		row(`${RED}⚠ progress file unreadable${RESET}`);
		const bot = `${box.bl}${box.h.repeat(inner + 2)}${box.br}`;
		lines.push(bot);
		return lines.join("\n");
	}

	if (opts.stale) {
		row(`${YELLOW}⚠ stale: no update for >60s (last @ ${p.updatedAt})${RESET}`);
		blank();
	}

	const acceptedFrac = p.target > 0 ? p.accepted / p.target : 0;
	const acceptedPctStr = fmtPct(acceptedFrac);
	const elapsed = fmtDuration(p.elapsedSec);
	const eta = p.done ? "done" : fmtEta(p.etaSec);

	// Line 1: Target + Elapsed
	const l1Left = `Target: ${p.target}`;
	const l1Right = `Elapsed: ${elapsed}`;
	row(
		`${l1Left}${" ".repeat(Math.max(1, inner - l1Left.length - l1Right.length))}${l1Right}`,
	);

	// Line 2: accepted / target (pct)  Borderline  Seeds
	const l2 =
		`Accepted: ${BOLD}${GREEN}${p.accepted}${RESET} / ${p.target} (${acceptedPctStr})` +
		`   Borderline: ${YELLOW}${p.borderline}${RESET}` +
		`   Seeds: ${p.seedsTried}/${p.maxSeeds}`;
	rowRaw(lines, box, inner, l2);

	blank();

	// Line: progress bar
	const barWidth = Math.max(10, inner - 10);
	const bar = progressBar(acceptedFrac, barWidth);
	const coloredBar = p.done
		? `${GREEN}${bar}${RESET}`
		: `${GREEN}${bar}${RESET}`;
	rowRaw(lines, box, inner, ` ${coloredBar}  ${acceptedPctStr}`);

	blank();

	// Acceptance rate + ETA
	const accRate = fmtPct(p.acceptanceRate);
	const line = `Acceptance rate: ${accRate}          ETA: ${eta}`;
	row(line);

	blank();

	// Drop reasons
	row("Drop reasons:");
	const totalDrops =
		p.droppedAtLeak +
		p.droppedAtAnswerability +
		p.droppedAtCritic +
		p.droppedAtJudges +
		p.droppedAtDedup +
		p.droppedAtError;
	const dropFracStr = (n: number) =>
		totalDrops > 0 ? ` (${((n / totalDrops) * 100).toFixed(1)}%)` : "";
	const dr = (label: string, n: number) =>
		`  ${padRight(label, 15)} ${String(n).padStart(5)}${dropFracStr(n)}`;
	row(dr("leak", p.droppedAtLeak));
	row(dr("answerability", p.droppedAtAnswerability));
	row(dr("critic", p.droppedAtCritic));
	row(dr("judges", p.droppedAtJudges));
	row(dr("dedup", p.droppedAtDedup));
	row(dr("error", p.droppedAtError));

	blank();

	if (p.lastAccepted) {
		row(
			`Last accepted: ${GREEN}${p.lastAccepted.id}${RESET} · ${p.lastAccepted.voice} · ${p.lastAccepted.materia} · ${p.lastAccepted.jurisdiction}`,
		);
		row(`  ${DIM}"${p.lastAccepted.question}"${RESET}`);
	} else {
		row(`${DIM}Last accepted: —${RESET}`);
	}

	blank();

	if (p.lastBorderline) {
		row(
			`Last borderline: ${YELLOW}${p.lastBorderline.id}${RESET} · ${p.lastBorderline.votes}`,
		);
		row(`  ${DIM}"${p.lastBorderline.question}"${RESET}`);
	} else {
		row(`${DIM}Last borderline: —${RESET}`);
	}

	if (p.done && p.finalStats) {
		blank();
		row(`${BOLD}── DONE ──${RESET}`);
		const fs = p.finalStats;
		row(
			`${BOLD}accepted=${fs.accepted}  borderline=${fs.borderline}  seeds=${fs.seedsTried}  drafts=${fs.draftsGenerated}${RESET}`,
		);
		row(
			`${BOLD}drops: leak=${fs.droppedAtLeak} ans=${fs.droppedAtAnswerability} critic=${fs.droppedAtCritic} judges=${fs.droppedAtJudges} dedup=${fs.droppedAtDedup} err=${fs.droppedAtError}${RESET}`,
		);
		row(`${DIM}press Ctrl+C to exit${RESET}`);
	}

	const bot = `${box.bl}${box.h.repeat(inner + 2)}${box.br}`;
	lines.push(bot);
	return lines.join("\n");
}

/**
 * Row helper that accepts a string containing ANSI escapes.
 * We compute visible length by stripping escapes.
 */
function rowRaw(
	lines: string[],
	box: BoxChars,
	inner: number,
	content: string,
): void {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
	const visible = content.replace(/\x1b\[[0-9;]*m/g, "");
	const len = [...visible].length;
	const pad = Math.max(0, inner - len);
	lines.push(`${box.v} ${content}${" ".repeat(pad)} ${box.v}`);
}

function readProgress(file: string): ProgressFile | null {
	try {
		const raw = readFileSync(file, "utf8");
		return JSON.parse(raw) as ProgressFile;
	} catch {
		return null;
	}
}

function fileMtimeMs(file: string): number | null {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

export async function runWatch(opts: WatchOptions): Promise<void> {
	const intervalMs = opts.intervalMs ?? 1000;
	const staleMs = opts.staleMs ?? 60000;
	const out = process.stdout;

	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		out.write(SHOW_CURSOR);
	};

	process.on("SIGINT", () => {
		stop();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		stop();
		process.exit(0);
	});

	out.write(HIDE_CURSOR);

	const render = () => {
		const width = out.columns ?? 80;
		const missing = !existsSync(opts.file);
		const mtime = fileMtimeMs(opts.file);
		const stale = !missing && mtime !== null && Date.now() - mtime > staleMs;
		const p = missing ? null : readProgress(opts.file);
		const frame = buildFrame(p, width, { stale, missing });
		out.write(`${CLEAR}${frame}\n`);
	};

	render();
	if (opts.once) {
		stop();
		return;
	}

	await new Promise<void>((resolve) => {
		const timer = setInterval(() => {
			if (stopped) {
				clearInterval(timer);
				resolve();
				return;
			}
			render();
		}, intervalMs);
	});
}
