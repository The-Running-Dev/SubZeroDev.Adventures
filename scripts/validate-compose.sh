#!/bin/sh
# Validates the deployment Compose file (docker-compose.yml) without starting anything.
# DB_PASSWORD is required by the file; a placeholder is enough to resolve it.
set -eu

DB_PASSWORD="${DB_PASSWORD:-ci-placeholder}" docker compose config --quiet
