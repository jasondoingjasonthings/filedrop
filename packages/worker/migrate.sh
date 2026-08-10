#!/usr/bin/env bash
# Migrates the live SQLite database from the VPS into Cloudflare D1.
# Run this AFTER creating the D1 database and applying the schema.
#
# Usage:
#   ./migrate.sh <vps-alias>       e.g. ./migrate.sh filedrop
#   ./migrate.sh                   uses 'filedrop' as default alias

set -euo pipefail
VPS="${1:-filedrop}"

echo "→ Dumping SQLite from $VPS..."
ssh "$VPS" "sqlite3 /opt/data/filedrop.db .dump" > /tmp/filedrop-dump.sql

echo "→ Extracting INSERT statements (schema already applied)..."
grep -E '^INSERT INTO' /tmp/filedrop-dump.sql \
  | grep -v 'INSERT INTO sqlite_' \
  > /tmp/filedrop-inserts.sql

# D1 doesn't support BLOB literals from sqlite3 dump — warn if any exist
if grep -q "X'" /tmp/filedrop-inserts.sql; then
  echo "⚠  BLOB literals detected — these will be skipped by D1."
fi

echo "→ Importing into D1 (remote)..."
wrangler d1 execute filedrop --remote --file=/tmp/filedrop-inserts.sql

echo "✓ Migration complete."
echo ""
echo "Verify with:"
echo "  wrangler d1 execute filedrop --remote --command=\"SELECT COUNT(*) FROM files\""
echo "  wrangler d1 execute filedrop --remote --command=\"SELECT COUNT(*) FROM share_links\""
