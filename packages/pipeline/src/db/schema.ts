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

  -- Bills (proposed legislation from BOCG)
  CREATE TABLE IF NOT EXISTS bills (
    bocg_id       TEXT PRIMARY KEY,  -- e.g. BOCG-14-A-62-1
    title         TEXT NOT NULL,
    legislature   INTEGER NOT NULL,
    series        TEXT NOT NULL DEFAULT '',  -- A (proyectos) or B (proposiciones)
    publication_date TEXT NOT NULL DEFAULT '',
    pdf_url       TEXT NOT NULL DEFAULT '',
    alert_level   TEXT NOT NULL DEFAULT 'ok',  -- ok | high | critical
    total_modifications INTEGER NOT NULL DEFAULT 0,
    laws_modified INTEGER NOT NULL DEFAULT 0,
    critical_alerts INTEGER NOT NULL DEFAULT 0,
    high_alerts   INTEGER NOT NULL DEFAULT 0,
    has_penalty_changes INTEGER NOT NULL DEFAULT 0,
    has_type_eliminations INTEGER NOT NULL DEFAULT 0,
    transitional_check_json TEXT NOT NULL DEFAULT '{}',
    analyzed_at   TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_bills_legislature ON bills(legislature);
  CREATE INDEX IF NOT EXISTS idx_bills_alert_level ON bills(alert_level);

  -- Bill modification groups + individual modifications
  CREATE TABLE IF NOT EXISTS bill_modifications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bocg_id       TEXT NOT NULL REFERENCES bills(bocg_id),
    group_index   INTEGER NOT NULL,  -- position of the group in the bill
    group_title   TEXT NOT NULL DEFAULT '',
    target_law    TEXT NOT NULL DEFAULT '',
    norm_id       TEXT NOT NULL DEFAULT '',  -- resolved BOE norm id
    ordinal       TEXT NOT NULL DEFAULT '',
    change_type   TEXT NOT NULL DEFAULT '',  -- modify | add | delete | derogate | renumber | suppress_chapter
    target_provision TEXT NOT NULL DEFAULT '',
    new_text      TEXT NOT NULL DEFAULT '',
    source_text   TEXT NOT NULL DEFAULT '',
    penalty_risk  TEXT NOT NULL DEFAULT 'none',  -- none | low | medium | high | critical
    penalty_json  TEXT NOT NULL DEFAULT '{}'  -- PenaltyComparison as JSON
  );

  CREATE INDEX IF NOT EXISTS idx_bill_mods_bocg ON bill_modifications(bocg_id);
  CREATE INDEX IF NOT EXISTS idx_bill_mods_norm ON bill_modifications(norm_id);

  -- Bill impact analysis (LLM-generated, per affected law)
  CREATE TABLE IF NOT EXISTS bill_impacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bocg_id       TEXT NOT NULL REFERENCES bills(bocg_id),
    norm_id       TEXT NOT NULL DEFAULT '',
    target_law    TEXT NOT NULL DEFAULT '',
    impact_json   TEXT NOT NULL DEFAULT '{}',  -- structured LLM analysis
    blast_radius_json TEXT NOT NULL DEFAULT '[]',  -- affected norms via reference graph
    generated_at  TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_bill_impacts_bocg ON bill_impacts(bocg_id);
  CREATE INDEX IF NOT EXISTS idx_bill_impacts_norm ON bill_impacts(norm_id);

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
