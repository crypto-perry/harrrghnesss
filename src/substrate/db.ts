import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  vendor        TEXT NOT NULL,
  source_path   TEXT NOT NULL UNIQUE,
  cwd           TEXT,
  started_at    INTEGER,
  last_event_at INTEGER
);

CREATE TABLE IF NOT EXISTS capsules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  vendor     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  files      TEXT NOT NULL DEFAULT '[]',
  summary    TEXT NOT NULL,
  raw_ref    TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'task'
);
CREATE INDEX IF NOT EXISTS idx_capsules_ts      ON capsules(ts);
CREATE INDEX IF NOT EXISTS idx_capsules_session ON capsules(session_id);
CREATE INDEX IF NOT EXISTS idx_capsules_kind    ON capsules(kind);

-- trigram FTS over summary+files: typo-tolerant, identifier-friendly, no embeddings (monolex lesson)
CREATE VIRTUAL TABLE IF NOT EXISTS capsules_fts USING fts5(
  summary, files, tokenize = 'trigram'
);

-- per-source-file byte offsets: parse once, never re-read (lazy sync)
CREATE TABLE IF NOT EXISTS tailer_offsets (
  source_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  line_no     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- per-consumer high-water marks: delta injection without rehydration
CREATE TABLE IF NOT EXISTS watermarks (
  consumer_id     TEXT PRIMARY KEY,
  last_capsule_id INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- junction: which commit eventually absorbed a capsule's changes (NULL-absence = uncommitted/abandoned)
CREATE TABLE IF NOT EXISTS commit_work_mapping (
  commit_hash TEXT NOT NULL,
  repo        TEXT NOT NULL,
  capsule_id  INTEGER NOT NULL,
  PRIMARY KEY (commit_hash, capsule_id)
);
`;

export type SubstrateDb = Database.Database;

export function openDb(dbPath: string): SubstrateDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  return db;
}
