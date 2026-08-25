#!/bin/sh
# Prio — nightly PostgreSQL backup.
#
# Runs inside the postgres container (the compose file mounts this directory at
# /scripts). Writes a compressed custom-format dump, then prunes dumps older
# than RETENTION_DAYS.
#
# Manual run:
#   docker compose exec postgres sh /scripts/backup.sh
#
# Nightly at 02:00 on the host (Linux cron):
#   0 2 * * * cd /srv/prio && docker compose exec -T postgres sh /scripts/backup.sh
#
# Nightly on Windows — Task Scheduler action:
#   Program:   docker
#   Arguments: compose -f D:\path\to\prio\docker-compose.yml exec -T postgres sh /scripts/backup.sh

set -eu

DB_NAME="${POSTGRES_DB:-prio}"
DB_USER="${POSTGRES_USER:-prio}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/postgresql/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/prio-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "Backing up ${DB_NAME} to ${TARGET}"

# --format=custom is compressed and restorable selectively with pg_restore.
pg_dump \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$TARGET"

SIZE="$(du -h "$TARGET" | cut -f1)"
echo "Backup complete: ${TARGET} (${SIZE})"

echo "Pruning backups older than ${RETENTION_DAYS} days"
find "$BACKUP_DIR" -name 'prio-*.dump' -type f -mtime "+${RETENTION_DAYS}" -delete

echo "Retained backups:"
ls -1t "$BACKUP_DIR" | head -20
