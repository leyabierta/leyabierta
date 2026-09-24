/**
 * RETIRED (2026-09-24): email alerts were removed (no accounts, no emails).
 *
 * This stub only exists so an older daily-pipeline.sh on the host (which still
 * runs "Step 8: Send notifications" until refs/tags/prod moves) does not fail
 * under `set -euo pipefail`. Delete it in the next release.
 */
console.log("send-notifications: retirado (24/09/2026) — no se envían correos");
process.exit(0);
