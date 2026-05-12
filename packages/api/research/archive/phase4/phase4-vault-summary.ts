/**
 * Final Phase 4 wake-up summary for the Obsidian Vault. Reads phase4-results.md
 * and writes a Spanish digest to the Vault that the user can read first thing.
 */

import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../../");
const reportPath = join(repoRoot, "data/ab-results/phase4-results.md");
const vaultPath =
	"/Users/alex/Documents/Obsidian Vault/10-Projects/Ley-Abierta/research/2026-05-10-phase4-results.md";

const reportFile = Bun.file(reportPath);
if (!(await reportFile.exists())) {
	console.error(`Missing ${reportPath}`);
	process.exit(1);
}
const report = await reportFile.text();

// Extract the variant table for a TL;DR
const tableMatch = report.match(/## Variant matrix\s+\n\s*\n([\s\S]*?)\n\n/);
const recMatch = report.match(/## Recommendation\s+\n\s*\n([\s\S]*?)$/);

const wakeUp = `---
project: ley-abierta
date: 2026-05-10
last-updated: ${new Date().toISOString().slice(0, 16)}
tags: [ley-abierta, research, rag, embeddings, phase-4]
status: completed
---

# Phase 4 — Resultados overnight (read first)

> Generado automáticamente al finalizar el orchestrator.
> Reporte completo: [[2026-05-10-phase4-overnight-rationale]] · raw data en \`data/ab-results/phase4-results.md\`.

## Lo más importante

${recMatch ? recMatch[1] : "(recomendación no disponible — revisa phase4-results.md)"}

## Tabla de variantes

${tableMatch ? tableMatch[1] : "(tabla no disponible)"}

## Próximos pasos

1. Si la mejor variante supera Gemini en R@1 → migrar prod \`EMBEDDING_MODEL_KEY\` a \`qwen3-nan\` y aplicar la intervención ganadora.
2. Si empate o pequeño déficit → migrar igualmente (gratis, +R@5/R@10) y aceptar trade-off.
3. Calibrar \`LOW_CONFIDENCE_THRESHOLD\` para Qwen antes de prod.
4. Si HyDE ganó: añadir el query rewrite como un paso del pipeline (qwen3.6 NaN, ~1s extra/query).
5. Si summary index ganó: completar embed (currently ~partial) y añadir multi-vector retrieval.

## Archivos

- \`data/ab-results/phase4-results.md\` — tabla completa con R@K, MRR, top-1 misses por variante.
- \`data/ab-results/phase4-status.md\` — snapshot del run (refrescado durante el overnight).
- \`data/ab-results/eval-pass-qwen-*.json\` — pass files por variante.
- \`packages/api/research/ab/run-phase4-overnight.sh\` — orchestrator.
- \`packages/api/research/ab/phase4-extra-merges.sh\` — merges adicionales pendientes.

## Reporte completo (copia íntegra)

${report}
`;

await Bun.write(vaultPath, wakeUp);
console.log(`✅ Vault summary written → ${vaultPath}`);
