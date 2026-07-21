#!/usr/bin/env bun
// Refresh STATE.md — the "current state / last thesis" context the next
// iteration's planner reads. Called by seo-loop.sh right after planning so the
// bitácora doesn't go stale (STATE.md was previously read but never written).
//
//   bun run scripts/seo/write-state.ts <plan.json>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, type GscSnapshot, type Plan } from "./lib.ts";

const planPath = process.argv[2];
if (!planPath) throw new Error("usage: write-state.ts <plan.json>");

const gsc = JSON.parse(
	readFileSync(join(DATA_DIR, "gsc-latest.json"), "utf8"),
) as GscSnapshot;
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
const t = gsc.totals;
const p = gsc.prevTotals;

writeFileSync(
	join(DATA_DIR, "STATE.md"),
	`# STATE — iteración ${plan.iteration} (${plan.snapshotDate})\n\n` +
		`## GSC (ventana ${gsc.window.start}..${gsc.window.end})\n` +
		`- clicks ${t.clicks} (prev ${p.clicks})\n` +
		`- impressions ${t.impressions} (prev ${p.impressions})\n` +
		`- posición media ${t.position.toFixed(1)} · CTR ${(t.ctr * 100).toFixed(2)}%\n` +
		`- páginas con impresiones ${t.pagesWithImpressions} (prev ${p.pagesWithImpressions})\n\n` +
		`## Última tesis (modelo ${plan.model})\n${plan.summary}\n\n` +
		`## Acciones propuestas esta iteración\n${plan.actions
			.map((a) => `- [${a.type}] ${a.change}`)
			.join("\n")}\n`,
);
console.log(`✓ STATE.md refreshed (iter ${plan.iteration})`);
