#!/bin/sh
# Gives both build targets one command vocabulary, so docker-compose.yml and
# server/docker-compose.yml say `command: serve` and `command: migrate` identically even
# though `dev` runs TypeScript through tsx from source and `runtime` runs emitted JS from
# dist/. Without this, the two compose files would have to name different entry paths for
# the same two operations, and the deployment file would encode the image's internal
# layout.
set -eu

case "${1:-serve}" in
serve)
	# Deliberately unquoted: ADVENTURES_SERVE_CMD is a command *line* ("node dist/..." or
	# "tsx src/index.ts"), set by the Dockerfile stage and never by a caller, so word
	# splitting here is the point. `exec` matters -- it puts node in PID 1 so the SIGINT/
	# SIGTERM handlers in server/src/index.ts actually receive `docker stop`, which they
	# would not through an intervening `npm run`.
	# shellcheck disable=SC2086
	exec ${ADVENTURES_SERVE_CMD:?ADVENTURES_SERVE_CMD is not set -- the image is misbuilt}
	;;
migrate)
	# node-pg-migrate resolves its migrations directory relative to the working directory
	# and its connection from DATABASE_URL. Both stages set WORKDIR so that `migrations/`
	# sits directly beneath it, and put node_modules/.bin on PATH.
	exec node-pg-migrate up
	;;
*)
	# Anything else is run verbatim, so `docker compose run --rm api sh` and one-off
	# `node-pg-migrate down` still work without a second entrypoint.
	exec "$@"
	;;
esac
