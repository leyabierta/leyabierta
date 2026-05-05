#!/usr/bin/env bun
/**
 * Pre-extract corpus blocks to JSON for fast tuning.
 * No dependencies on project modules — pure Bun + SQLite.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

// Absolute paths — the DB is at data/leyabierta.db relative to repo root
const repoRoot = "/Users/alex/00_Programacion/01_Alex/leyabierta/leyabierta";
const dbPath = join(repoRoot, "data", "leyabierta.db");
const outPath = join(repoRoot, "data", "corpus-preceptos.json");

console.log("Extracting corpus preceptos from SQLite DB...");
const t0 = Date.now();

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = OFF");

// Get plan: active norms
const normIds = db
  .query<{ id: string }>("SELECT id FROM norms WHERE status != 'derogada'")
  .all()
  .map((r) => r.id);

console.log(`  Active norms: ${normIds.length}`);

const ph = normIds.map(() => "?").join(",");
const rows = db
  .query<{ norm_id: string; norm_title: string; block_id: string; title: string; current_text: string }>(
    `SELECT b.norm_id, n.title as norm_title, b.block_id, b.title, b.current_text
     FROM blocks b
     JOIN norms n ON n.id = b.norm_id
     WHERE b.norm_id IN (${ph})
       AND b.block_type = 'precepto'
       AND b.current_text != ''
     ORDER BY b.norm_id, b.position`,
  )
  .all(...normIds);

console.log(`  Precepto blocks: ${rows.length}`);

// Simple apartado splitting (regex-based, no project dependency)
function splitApartados(text: string): string[] {
  const parts = text.split(/(?=Apartado\s+\[?\d+\]?)/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 10);
}

const blocks: Array<{ normId: string; blockId: string; parentBlockId: string; text: string; rawText: string }> = [];

for (const r of rows) {
  const subParts = splitApartados(r.current_text);
  if (subParts.length > 1) {
    for (let i = 0; i < subParts.length; i++) {
      const part = subParts[i];
      blocks.push({
        normId: r.norm_id,
        blockId: `${r.block_id}_ap${i}`,
        parentBlockId: r.block_id,
        text: `title: ${r.norm_title} | text: ${r.title} (apartado ${i})\n\n${part}`,
        rawText: part,
      });
    }
  } else {
    blocks.push({
      normId: r.norm_id,
      blockId: r.block_id,
      parentBlockId: r.block_id,
      text: `title: ${r.norm_title} | text: ${r.title}\n\n${r.current_text}`,
      rawText: r.current_text,
    });
  }
}

console.log(`  Total blocks (with apartados): ${blocks.length}`);

// Stratified sample if too large
const MAX_BLOCKS = 8000;
if (blocks.length > MAX_BLOCKS) {
  const normCounts: Record<string, number> = {};
  for (const b of blocks) {
    normCounts[b.normId] = (normCounts[b.normId] ?? 0) + 1;
  }
  const total = blocks.length;
  const sampled: typeof blocks = [];
  for (const [normId, count] of Object.entries(normCounts)) {
    const sampleCount = Math.max(5, Math.round((count / total) * MAX_BLOCKS));
    const normBlocks = blocks.filter((b) => b.normId === normId);
    for (let i = normBlocks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [normBlocks[i]!, normBlocks[j]!] = [normBlocks[j]!, normBlocks[i]!];
    }
    sampled.push(...normBlocks.slice(0, sampleCount));
  }
  blocks.length = 0;
  blocks.push(...sampled);
  console.log(`  Sampled to ${blocks.length} blocks (stratified)`);
} else {
  console.log(`  No sampling needed (${blocks.length} blocks)`);
}

// Write JSON
console.log(`Writing to ${outPath}...`);
await Bun.write(outPath, JSON.stringify(blocks));
const size = (await Bun.file(outPath).size()) / 1024 / 1024;
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${size.toFixed(0)}MB, ${blocks.length} blocks`);

db.close();
