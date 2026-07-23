/**
 * Recalculate `norms.authority_score` from scratch, from the current
 * contents of `referencias` (issue #131 ranking).
 *
 * Does NOT re-ingest anything — `referencias` is already populated by
 * `ingest-analisis` (packages/pipeline/src/ingest-analisis-cli.ts), which
 * calls this same recompute at the end of its own run. This script exists
 * so the score can also be (re)built standalone: after changing the
 * scoring/exclusion rules in packages/pipeline/src/db/authority.ts, on a
 * DB that predates the `authority_score` column (createSchema's migration
 * adds it, defaulted to 0, but never backfills it), or just to audit the
 * current numbers.
 *
 * Idempotent: safe to run repeatedly, safe to run directly against the
 * production DB (data/leyabierta.db) with the API/pipeline running —
 * it opens the DB in WAL mode and does a single short transaction.
 *
 * Usage:
 *   bun run packages/api/src/scripts/recalculate-authority-scores.ts
 *   bun run packages/api/src/scripts/recalculate-authority-scores.ts --dry-run
 */

import { recalculateAuthorityScores } from "@leyabierta/pipeline";
import { hasFlag, setupDb } from "./shared.ts";

const dryRun = hasFlag("dry-run");

const { db } = setupDb();

console.log(
	`\n📊 Recalculating authority_score${dryRun ? " (dry run)" : ""}...`,
);

const result = recalculateAuthorityScores(db, { dryRun });

console.log(`   Norms scanned:  ${result.total}`);
console.log(`   Norms changed:  ${result.changed}`);
console.log(`   Max authority_score: ${result.max}`);
console.log(
	dryRun
		? "\n   Dry run — no rows written. Re-run without --dry-run to apply."
		: "\n   Done.",
);
