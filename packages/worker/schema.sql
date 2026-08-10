-- FileDrop D1 schema — clean slate (no incremental ALTER TABLE needed)

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('owner','editor')),
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  r2_key           TEXT NOT NULL UNIQUE,
  size             INTEGER DEFAULT 0,
  folder           TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'uploading'
                     CHECK(status IN ('uploading','available','downloaded','deleting','deleted')),
  upload_progress  INTEGER DEFAULT 0,
  uploaded_at      TEXT,
  downloaded_by    INTEGER REFERENCES users(id),
  downloaded_at    TEXT,
  delete_at        TEXT,
  deleted_at       TEXT,
  last_seen_at     TEXT,
  checksum         TEXT,
  thumbnail_key    TEXT,
  proxy_key        TEXT,
  updated_at       TEXT DEFAULT (datetime('now')),
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_folder   ON files(folder, status);
CREATE INDEX IF NOT EXISTS idx_files_updated  ON files(updated_at);
CREATE INDEX IF NOT EXISTS idx_files_status   ON files(status);

CREATE TABLE IF NOT EXISTS agent_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT UNIQUE NOT NULL,
  label      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS share_links (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  token             TEXT UNIQUE NOT NULL,
  folder            TEXT NOT NULL DEFAULT '',
  label             TEXT,
  expires_at        TEXT NOT NULL,
  cover_image_id    TEXT,
  zip_key           TEXT,
  zip_status        TEXT,
  zip_downloaded_at TEXT,
  zip_files_total   INTEGER,
  zip_files_done    INTEGER DEFAULT 0,
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upload_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT UNIQUE NOT NULL,
  folder     TEXT NOT NULL DEFAULT '',
  label      TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  username   TEXT NOT NULL,
  message    TEXT NOT NULL,
  folder     TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fulfilled')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  path          TEXT PRIMARY KEY,
  proxy_enabled INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  actor      TEXT,
  file_id    TEXT,
  file_name  TEXT,
  folder     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- FS command RPC (replaces in-memory Map — needed because Workers are stateless)
CREATE TABLE IF NOT EXISTS fs_commands (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  result     TEXT,
  error      TEXT,
  done       INTEGER DEFAULT 0,
  claimed    INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fs_commands ON fs_commands(done, claimed);
