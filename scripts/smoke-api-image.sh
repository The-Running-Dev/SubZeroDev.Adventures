#!/bin/sh
# Runs inside the API image's container (container.yml's `smoke-exec`).
#
# The server cannot start without a Postgres to build its content catalogue from, so the
# smoke test replaces the serve command with `sleep infinity` (ADVENTURES_SERVE_CMD) and
# checks what a bad image breaks first: the compiled app and its production-only
# dependencies, including the engine package, load as ES modules, and the tools the
# entrypoint's `migrate` command needs are present.
set -eu

cd /app/server

node --input-type=module --eval 'await import("/app/server/dist/server/src/app.js"); console.log("The compiled API loads.")'

command -v node-pg-migrate >/dev/null
test -f migrations/001_players.sql
test -f /app/public/campaigns/manifest.json
echo "node-pg-migrate, the migrations and the bootstrap campaigns are present."
