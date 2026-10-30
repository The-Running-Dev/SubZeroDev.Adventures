#!/bin/sh
# Validates the deployment Compose file (docker-compose.yml) without starting anything.
# DB_PASSWORD, LEDGER_DB_PASSWORD and BACKUP_RETENTION_DAYS are required by the file;
# placeholders are enough to resolve them.
set -eu

DB_PASSWORD="${DB_PASSWORD:-ci-placeholder}" \
  LEDGER_DB_PASSWORD="${LEDGER_DB_PASSWORD:-ci-placeholder}" \
  BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}" \
  docker compose config --quiet
