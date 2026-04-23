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
    country     TEXT NOT NULL,     -- ISO 3166-1 alpha-2 (always "es" for Spain)
    jurisdiction TEXT NOT NULL DEFAULT 'es', -- ELI jurisdiction: es, es-vc, es-ct, etc.
    rank        TEXT NOT NULL,
    published_at TEXT NOT NULL,    -- ISO date
    updated_at  TEXT,              -- ISO date
    status      TEXT NOT NULL,     -- vigente | derogada | parcialmente_derogada
    department  TEXT NOT NULL DEFAULT '',
    source_url  TEXT NOT NULL DEFAULT '',
    citizen_summary TEXT NOT NULL DEFAULT ''
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
  CREATE INDEX IF NOT EXISTS idx_reform_blocks_lookup ON reform_blocks(norm_id, reform_date, reform_source_id);

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
  CREATE INDEX IF NOT EXISTS idx_materias_materia ON materias(materia);
  CREATE INDEX IF NOT EXISTS idx_referencias_norm ON referencias(norm_id);
  CREATE INDEX IF NOT EXISTS idx_referencias_target ON referencias(target_id);

  -- Partial indexes for anomaly detection (fast scans)
  CREATE INDEX IF NOT EXISTS idx_blocks_empty_precepto
    ON blocks(norm_id) WHERE block_type = 'precepto' AND (current_text = '' OR current_text IS NULL);

  -- Citizen-friendly tags (LLM-generated, law-level and article-level)
  CREATE TABLE IF NOT EXISTS citizen_tags (
    norm_id     TEXT NOT NULL REFERENCES norms(id),
    block_id    TEXT NOT NULL DEFAULT '',  -- '' = law-level, non-empty = article-level
    tag         TEXT NOT NULL,
    PRIMARY KEY (norm_id, block_id, tag)
  );

  CREATE INDEX IF NOT EXISTS idx_citizen_tags_norm ON citizen_tags(norm_id);
  CREATE INDEX IF NOT EXISTS idx_citizen_tags_tag ON citizen_tags(tag);

  -- Citizen-friendly article summaries (LLM-generated)
  CREATE TABLE IF NOT EXISTS citizen_article_summaries (
    norm_id     TEXT NOT NULL,
    block_id    TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (norm_id, block_id),
    FOREIGN KEY (norm_id, block_id) REFERENCES blocks(norm_id, block_id)
  );

  -- Norm follows (users following specific laws for change notifications)
  CREATE TABLE IF NOT EXISTS norm_follows (
    email       TEXT NOT NULL,
    norm_id     TEXT NOT NULL REFERENCES norms(id),
    confirmed   INTEGER NOT NULL DEFAULT 0,
    token       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (email, norm_id)
  );

  CREATE INDEX IF NOT EXISTS idx_norm_follows_norm ON norm_follows(norm_id);
  CREATE INDEX IF NOT EXISTS idx_norm_follows_token ON norm_follows(token);

  -- AI-generated reform summaries (separate from factual reforms table)
  CREATE TABLE IF NOT EXISTS reform_summaries (
    norm_id      TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    reform_date  TEXT NOT NULL,
    reform_type  TEXT NOT NULL DEFAULT '',
    headline     TEXT NOT NULL DEFAULT '',
    summary      TEXT NOT NULL DEFAULT '',
    importance   TEXT NOT NULL DEFAULT '',
    generated_at TEXT NOT NULL DEFAULT '',
    model        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (norm_id, source_id, reform_date),
    FOREIGN KEY (norm_id, reform_date, source_id)
      REFERENCES reforms(norm_id, date, source_id)
  );

  -- Notified reforms tracking (prevents duplicate email sends)
  CREATE TABLE IF NOT EXISTS notified_reforms (
    norm_id      TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    reform_date  TEXT NOT NULL,
    notified_at  TEXT NOT NULL,
    PRIMARY KEY (norm_id, source_id, reform_date),
    FOREIGN KEY (norm_id, reform_date, source_id)
      REFERENCES reforms(norm_id, date, source_id)
  );

  -- Omnibus law topic breakdowns (AI-generated, per-norm)
  CREATE TABLE IF NOT EXISTS omnibus_topics (
    norm_id       TEXT NOT NULL,
    topic_index   INTEGER NOT NULL,
    topic_label   TEXT NOT NULL DEFAULT '',
    headline      TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    article_count INTEGER NOT NULL DEFAULT 0,
    is_sneaked    INTEGER NOT NULL DEFAULT 0,
    related_materias TEXT NOT NULL DEFAULT '',
    block_ids     TEXT NOT NULL DEFAULT '',
    generated_at  TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (norm_id, topic_index),
    FOREIGN KEY (norm_id) REFERENCES norms(id)
  );

  -- Embedding vectors for RAG (stored as BLOBs, loaded into Float32Array at runtime)
  -- Each row is one article/sub-chunk embedding. The flat array format used previously
  -- (vectors.bin) hit a 2GB file size limit. SQLite has no practical size limit (~281TB),
  -- supports atomic inserts (crash-safe), and allows incremental add/remove per norm.
  CREATE TABLE IF NOT EXISTS embeddings (
    norm_id     TEXT NOT NULL,
    block_id    TEXT NOT NULL,
    model       TEXT NOT NULL,
    vector      BLOB NOT NULL,
    PRIMARY KEY (norm_id, block_id, model)
  );

  CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);

  -- RAG ask log: tracks user questions, answers, and quality metrics
  CREATE TABLE IF NOT EXISTS ask_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    jurisdiction TEXT,
    answer TEXT,
    declined INTEGER NOT NULL DEFAULT 0,
    citations_count INTEGER NOT NULL DEFAULT 0,
    articles_retrieved INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    best_score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- FTS5 virtual table for full-text search (title + content + citizen data)
  CREATE VIRTUAL TABLE IF NOT EXISTS norms_fts USING fts5(
    norm_id UNINDEXED,
    title,
    content,
    citizen_tags,
    citizen_summary,
    tokenize='unicode61 remove_diacritics 2'
  );
`;

export function createSchema(db: Database): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(SCHEMA_SQL);

	// Migrations: add columns that may be missing on existing databases
	try {
		db.exec(
			"ALTER TABLE norms ADD COLUMN citizen_summary TEXT NOT NULL DEFAULT ''",
		);
	} catch {
		// Column already exists
	}

	try {
		db.exec(
			"ALTER TABLE norms ADD COLUMN jurisdiction TEXT NOT NULL DEFAULT 'es'",
		);
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_norms_jurisdiction ON norms(jurisdiction)",
		);
	} catch {
		// Column already exists
	}

	try {
		db.exec(
			"ALTER TABLE omnibus_topics ADD COLUMN related_materias TEXT NOT NULL DEFAULT ''",
		);
	} catch {
		// Column already exists
	}

	try {
		db.exec(
			"ALTER TABLE omnibus_topics ADD COLUMN block_ids TEXT NOT NULL DEFAULT ''",
		);
	} catch {
		// Column already exists
	}
}
