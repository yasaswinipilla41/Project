#!/bin/sh
# Prio — restore a PostgreSQL backup produced by backup.sh.
#
#   docker compose exec postgres sh /scripts/restore.sh /var/lib/postgresql/backups/prio-20260820-020000.dump
#
# This DROPS and recreates the public schema before restoring. Stop the app
# container first so nothing writes mid-restore:
#
#   docker compose stop app
#   docker compose exec postgres sh /scripts/restore.sh <dump>
#   docker compose start app

set -eu

DUMP_FILE="${1:-}"
DB_NAME="${POSTGRES_DB:-prio}"
DB_USER="${POSTGRES_USER:-prio}"

if [ -z "$DUMP_FILE" ]; then
  echo "Usage: restore.sh <path-to-dump>" >&2
  exit 1
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "No such dump: $DUMP_FILE" >&2
  exit 1
fi

echo "About to restore ${DUMP_FILE} into ${DB_NAME}."
echo "This destroys the current contents of the public schema."

psql --username="$DB_USER" --dbname="$DB_NAME" \
  -c 'DROP SCHEMA IF EXISTS public CASCADE;' \
  -c 'CREATE SCHEMA public;'

pg_restore \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --no-owner \
  --no-privileges \
  "$DUMP_FILE"

echo "Restore complete."
echo "Run 'docker compose run --rm app npx prisma migrate deploy' if the dump predates the current migrations."
