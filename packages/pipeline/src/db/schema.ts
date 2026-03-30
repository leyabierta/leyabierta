/**
 * SQLite schema for legislative data.
 *
 * Uses bun:sqlite with FTS5 for full-text search across
 * law titles and article content.
 */

import type { Database } from "bun:sqlite";

const SCHEMA_SQL = /* sql */ `
  -- Main norms table (one row per law)
  CREATE TABLE IF NOT EXISTS norms (
    id          TEXT PRIMARY KEY,  -- e.g. BOE-A-1978-31229
    title       TEXT NOT NULL,
    short_title TEXT NOT NULL DEFAULT '',
    country     TEXT NOT NULL,     -- ISO 3166-1 alpha-2
    rank        TEXT NOT NULL,
    published_at TEXT NOT NULL,    -- ISO date
    updated_at  TEXT,              -- ISO date
    status      TEXT NOT NULL,     -- vigente | derogada | parcialmente_derogada
    department  TEXT NOT NULL DEFAULT '',
    source_url  TEXT NOT NULL DEFAULT ''
  );

  -- Structural blocks (articles, chapters, etc.)
  CREATE TABLE IF NOT EXISTS blocks (
    norm_id     TEXT NOT NULL REFERENCES norms(id),
    block_id    TEXT NOT NULL,
    block_type  TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL,
    current_text TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (norm_id, block_id)
  );

  -- Historical versions of each block
  CREATE TABLE IF NOT EXISTS versions (
    norm_id     TEXT NOT NULL,
    block_id    TEXT NOT NULL,
    date        TEXT NOT NULL,     -- ISO date
    source_id   TEXT NOT NULL,     -- e.g. BOE-A-2024-3099
    text        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (norm_id, block_id, date),
    FOREIGN KEY (norm_id, block_id) REFERENCES blocks(norm_id, block_id)
  );

  -- Reform events
  CREATE TABLE IF NOT EXISTS reforms (
    norm_id     TEXT NOT NULL REFERENCES norms(id),
    date        TEXT NOT NULL,     -- ISO date
    source_id   TEXT NOT NULL,
    PRIMARY KEY (norm_id, date, source_id)
  );

  -- Junction: which blocks each reform affected
  CREATE TABLE IF NOT EXISTS reform_blocks (
    norm_id     TEXT NOT NULL,
    reform_date TEXT NOT NULL,
    reform_source_id TEXT NOT NULL,
    block_id    TEXT NOT NULL,
    PRIMARY KEY (norm_id, reform_date, reform_source_id, block_id),
    FOREIGN KEY (norm_id, reform_date, reform_source_id)
      REFERENCES reforms(norm_id, date, source_id),
    FOREIGN KEY (norm_id, block_id) REFERENCES blocks(norm_id, block_id)
  );

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_norms_country ON norms(country);
  CREATE INDEX IF NOT EXISTS idx_norms_rank ON norms(rank);
  CREATE INDEX IF NOT EXISTS idx_norms_status ON norms(status);
  CREATE INDEX IF NOT EXISTS idx_blocks_norm ON blocks(norm_id);
  CREATE INDEX IF NOT EXISTS idx_versions_norm_block ON versions(norm_id, block_id);
  CREATE INDEX IF NOT EXISTS idx_reforms_norm ON reforms(norm_id);

  -- Materias (subject categories from BOE análisis)
  CREATE TABLE IF NOT EXISTS materias (
    norm_id     TEXT NOT NULL REFERENCES norms(id),
    materia     TEXT NOT NULL,
    PRIMARY KEY (norm_id, materia)
  );

  -- Notas (notes from BOE análisis)
  CREATE TABLE IF NOT EXISTS notas (
    norm_id     TEXT NOT NULL REFERENCES norms(id),
    nota        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (norm_id, position)
  );

  -- References between norms (from BOE análisis)
  CREATE TABLE IF NOT EXISTS referencias (
    norm_id     TEXT NOT NULL REFERENCES norms(id),
    direction   TEXT NOT NULL,     -- 'anterior' | 'posterior'
    relation    TEXT NOT NULL,     -- e.g. 'SE MODIFICA', 'DEROGA'
    target_id   TEXT NOT NULL,     -- referenced norm id
    text        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (norm_id, direction, target_id, relation)
  );

  CREATE INDEX IF NOT EXISTS idx_materias_norm ON materias(norm_id);
  CREATE INDEX IF NOT EXISTS idx_referencias_norm ON referencias(norm_id);
  CREATE INDEX IF NOT EXISTS idx_referencias_target ON referencias(target_id);

  -- FTS5 virtual table for full-text search (title + content)
  CREATE VIRTUAL TABLE IF NOT EXISTS norms_fts USING fts5(
    norm_id UNINDEXED,
    title,
    content,
    tokenize='unicode61 remove_diacritics 2'
  );
`;

export function createSchema(db: Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(SCHEMA_SQL);
}
