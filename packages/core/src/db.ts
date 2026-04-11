import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transfers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT    NOT NULL,
  local_path   TEXT    NOT NULL,
  source_path  TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  md5          TEXT    NOT NULL,
  direction    TEXT    NOT NULL CHECK (direction IN ('upload', 'download')),
  status       TEXT    NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('pending', 'queued', 'active', 'paused', 'done', 'error')),
  priority     INTEGER NOT NULL DEFAULT 100,
  progress     INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  project      TEXT,
  peer_name    TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  error        TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_transfers_status    ON transfers (status);
CREATE INDEX IF NOT EXISTS idx_transfers_direction ON transfers (direction);

CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  username         TEXT    NOT NULL UNIQUE,
  password_hash    TEXT    NOT NULL,
  role             TEXT    NOT NULL DEFAULT 'viewer'
                     CHECK (role IN ('owner', 'viewer')),
  email            TEXT,
  notify_email     INTEGER NOT NULL DEFAULT 0,
  notify_desktop   INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Folder subscriptions: this machine follows a folder on a peer
CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_name     TEXT    NOT NULL,
  remote_path   TEXT    NOT NULL,
  local_path    TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  subscribed_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (peer_name, remote_path)
);

-- Files downloaded from peers, used for the Library view
CREATE TABLE IF NOT EXISTS peer_files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  peer_name      TEXT    NOT NULL,
  relative_path  TEXT    NOT NULL,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  modified_at    TEXT,
  downloaded_at  TEXT,
  UNIQUE (peer_name, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_peer_files_peer ON peer_files (peer_name);
`;

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolved = dbPath ?? path.resolve(path.dirname(process.execPath), 'filedrop.db');
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(resolved);
  _db.exec(SCHEMA);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
