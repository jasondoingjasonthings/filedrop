'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'filedrop.db');

let _db;

function getDb() {
  if (!_db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    migrate(_db);
    migrateAlter(_db);
  }
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner','editor')),
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS files (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      r2_key       TEXT NOT NULL UNIQUE,
      size         INTEGER DEFAULT 0,
      folder       TEXT DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'uploading'
                     CHECK(status IN ('uploading','available','downloaded','deleting','deleted')),
      upload_progress INTEGER DEFAULT 0,
      uploaded_at  TEXT,
      downloaded_by INTEGER REFERENCES users(id),
      downloaded_at TEXT,
      delete_at    TEXT,
      deleted_at   TEXT,
      last_seen_at TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_tokens (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      label TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS share_links (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token      TEXT UNIQUE NOT NULL,
      folder     TEXT NOT NULL DEFAULT '',
      label      TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
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

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function migrateAlter(db) {
  // Add columns that didn't exist in earlier schema versions
  const cols = db.prepare(`PRAGMA table_info(files)`).all().map(c => c.name);
  if (!cols.includes('last_seen_at')) {
    db.exec(`ALTER TABLE files ADD COLUMN last_seen_at TEXT`);
  }
  if (!cols.includes('checksum')) {
    db.exec(`ALTER TABLE files ADD COLUMN checksum TEXT`);
  }
}

function ownerExists(db) {
  return db.prepare(`SELECT COUNT(*) as n FROM users WHERE role='owner'`).get().n > 0;
}

module.exports = { getDb, ownerExists };
