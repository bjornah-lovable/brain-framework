/**
 * SQLite schema for the brain. Single-writer rule: only the librarian
 * writes to `pages`, `blocks`, `provenance`, `captures` content.
 *
 * Inlined as a TS string so the runtime never has to locate a separate
 * .sql file relative to dist/.
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pages (
  path TEXT PRIMARY KEY,
  plane TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT,
  last_updated TEXT NOT NULL,
  status TEXT,
  frontmatter_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pages_plane ON pages(plane);
CREATE INDEX IF NOT EXISTS idx_pages_slug ON pages(slug);

CREATE TABLE IF NOT EXISTS blocks (
  block_id TEXT PRIMARY KEY,
  page_path TEXT NOT NULL REFERENCES pages(path) ON DELETE CASCADE,
  plane TEXT NOT NULL,
  slug TEXT NOT NULL,
  section TEXT NOT NULL,
  version INTEGER NOT NULL,
  heading TEXT,
  body TEXT NOT NULL DEFAULT '',
  last_updated TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_path);
CREATE INDEX IF NOT EXISTS idx_blocks_plane_slug ON blocks(plane, slug);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  block_id UNINDEXED,
  page_path UNINDEXED,
  heading,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS captures (
  path TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  project_slug TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  body TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_captures_project ON captures(project_slug);
CREATE INDEX IF NOT EXISTS idx_captures_unprocessed
  ON captures(processed_at) WHERE processed_at IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
  path UNINDEXED,
  body,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS provenance (
  block_id TEXT NOT NULL,
  capture_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  promoted_at TEXT NOT NULL,
  PRIMARY KEY (block_id, capture_path)
);

-- v3.5 (Tier 1.5d): per-block synthesized metadata. Populated by the
-- Sonnet librarian step. Searched in parallel with blocks_fts so that
-- "stuck rate" still finds a block that only mentions
-- fct_message.stuck_rate by metric name.
CREATE TABLE IF NOT EXISTS blocks_metadata (
  block_id TEXT PRIMARY KEY REFERENCES blocks(block_id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  search_terms_json TEXT NOT NULL DEFAULT '[]',
  last_updated TEXT NOT NULL,
  synthesizer_prompt_sha256 TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_meta_fts USING fts5(
  block_id UNINDEXED,
  page_path UNINDEXED,
  summary,
  aliases,
  entities,
  search_terms,
  tokenize = 'porter unicode61'
);
`;
