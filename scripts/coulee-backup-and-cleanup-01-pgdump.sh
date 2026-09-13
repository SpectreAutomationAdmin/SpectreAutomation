#!/bin/sh
# Backup script — installs postgresql 18 client on Alpine, runs pg_dump,
# saves to /app/tmp/. Credentials never printed.
set -eu

# Alpine 3.23 ships PG 17 in the main repo. Add the testing/edge repo for PG 18.
if ! apk info postgresql18-client >/tmp/apk.log 2>&1; then
  echo "http://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories
  echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories
fi

apk update >/tmp/apk.log 2>&1
apk add --no-cache postgresql18-client >>/tmp/apk.log 2>&1 || apk add --no-cache postgresql-client >>/tmp/apk.log 2>&1

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump install failed"
  tail -30 /tmp/apk.log
  exit 1
fi

pg_dump --version

mkdir -p /app/tmp
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/app/tmp/coulee-cleanup-backup-${STAMP}.sql.gz"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set"
  exit 1
fi

pg_dump --no-owner --no-acl --format=plain --clean --if-exists "$DATABASE_URL" | gzip -c > "$OUT"

SIZE="$(wc -c < "$OUT")"
echo "OK filename=${OUT} size=${SIZE}"
