# syntax=docker/dockerfile:1
#
# Build context is the repository root -- server/docker-compose.yml sets `context: ..` and
# deploy-api.yml sets `context: .`. This image needs engine/, shared/, and server/: the same
# three things server/src/composition.ts and shared/campaign-registry.ts reach across at
# runtime. public/campaigns/ is not among them -- it is test-fixture content only
# (server/src/index.ts's only content source is SubZeroDev.Adventures.Content), so it is
# deliberately not copied into either target below.
#
# Two targets the compose files pick between:
#   dev      -- server/docker-compose.yml. TypeScript straight through tsx, full
#               devDependencies, root user. Disposable and quick to rebuild.
#   runtime  -- the default, and what deploy-api.yml pushes to GHCR. tsc-emitted JS,
#               production-only dependencies, non-root.
#
# Both end at the same entrypoint, so both compose files say `command: serve` and
# `command: migrate` without either knowing which target it got.

ARG NODE_IMAGE=node:24-bookworm-slim

# Source commit this image was built from; 'development' for any local build. Re-declared
# inside `runtime` because a build ARG does not cross a stage boundary on its own.
ARG ADVENTURES_BUILD_REVISION=development

# ---- engine: build the submodule package -------------------------------------------
# engine/src/engine/dist is gitignored even inside the submodule itself (CLAUDE.md, "The
# Engine Submodule") and .dockerignore drops it from the build context regardless, so it
# has to be built here before server's `file:../engine/src/engine` dependency has anything
# to resolve to -- the same job scripts/setup-engine.mjs does for a local checkout.
FROM ${NODE_IMAGE} AS engine
WORKDIR /app
COPY engine/src/engine/package.json engine/src/engine/package-lock.json engine/src/engine/
RUN npm ci --prefix engine/src/engine
COPY engine/src/engine engine/src/engine
RUN npm run build --prefix engine/src/engine

# ---- deps: production-only node_modules ---------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=engine /app/engine/src/engine engine/src/engine
# Prunes the engine's own devDependencies (typescript, vitest, eslint) now that its dist/
# is built, leaving just its single runtime dependency, @noble/hashes. `npm prune` rather
# than a second `npm ci --omit=dev`: the `engine` stage already installed the full tree, so
# pruning it in place skips redownloading and reinstalling everything from scratch. `runtime`
# copies this directory verbatim: npm links the `file:` dependency below rather than copying
# it, so the engine's node_modules is where Node resolves that import from at runtime.
RUN npm prune --prefix engine/src/engine --omit=dev
COPY server/package.json server/package-lock.json server/
# The service-contract dependency is a vendored tgz (server/package.json), not a registry
# package -- `npm ci` needs it on disk before it runs, not just the manifests that name it.
COPY server/vendor server/vendor
RUN npm ci --prefix server --omit=dev

# ---- build: emit JS ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY --from=engine /app/engine/src/engine engine/src/engine
COPY server/package.json server/package-lock.json server/
# The service-contract dependency is a vendored tgz (server/package.json), not a registry
# package -- `npm ci` needs it on disk before it runs, not just the manifests that name it.
COPY server/vendor server/vendor
RUN npm ci --prefix server
# tsc resolves module specifiers the same way Node does, by walking node_modules up
# through a file's ancestors, so shared/campaign-registry.ts cannot see its sibling's
# server/node_modules and fails to resolve @the-running-dev/game-engine at compile time --
# TS2307, not a runtime error. Same line, same reason, as the `dev` target below and
# .github/workflows/ci.yml:101. `runtime` needs no equivalent: it puts dist/ under server/,
# where server/node_modules is a genuine ancestor.
RUN ln -s server/node_modules node_modules
# The root package.json is `"type": "module"` and is the nearest ancestor manifest to
# shared/. Under `module: nodenext` tsc reads it to decide shared/'s output format; without
# it, tsc would emit CommonJS for shared/campaign-registry.ts and the engine package --
# ESM-only, no "require" condition in its exports map -- would be unresolvable at runtime.
COPY package.json package.json
COPY shared shared
COPY server server
RUN npm run build --prefix server

# ---- dev -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS dev
WORKDIR /app
COPY --from=engine /app/engine/src/engine engine/src/engine
COPY server/package.json server/package-lock.json server/
# The service-contract dependency is a vendored tgz (server/package.json), not a registry
# package -- `npm ci` needs it on disk before it runs, not just the manifests that name it.
COPY server/vendor server/vendor
RUN npm ci --prefix server
COPY package.json package.json
COPY shared shared
COPY server server
# Node resolves a module's dependencies by walking node_modules up through its *ancestor*
# directories. /app/shared and /app/server are siblings, so server/node_modules is never on
# shared/campaign-registry.ts's path and its `@the-running-dev/game-engine` import would
# fail. `runtime` has no equivalent because a single /app/node_modules is an ancestor of
# the whole emitted tree there. .github/workflows/ci.yml:101 carries the same line for the
# same reason.
RUN ln -s server/node_modules node_modules
WORKDIR /app/server
ENV PATH=/app/server/node_modules/.bin:$PATH
ENV ADVENTURES_SERVE_CMD="tsx src/index.ts"
ENV ADVENTURES_MAINTAIN_CMD="tsx src/maintenance-cli.ts"
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve"]

# ---- runtime -------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG ADVENTURES_BUILD_REVISION=development
LABEL org.opencontainers.image.revision=${ADVENTURES_BUILD_REVISION}
LABEL org.opencontainers.image.source=https://github.com/The-Running-Dev/SubZeroDev.Adventures

# Reproduces the repository's own directory layout rather than flattening it, because two
# resolution rules both depend on it:
#
#   npm installs the `file:` engine dependency as a symlink whose target is stored relative
#   to its own location (server/node_modules/... -> ../../../engine/src/engine). Moving
#   either end breaks it, so engine/ keeps its position beside server/.
#
#   Node resolves a module's dependencies by walking node_modules up through its ancestor
#   directories. Putting dist/ *under* server/ makes server/node_modules an ancestor of the
#   emitted dist/shared/, so shared/campaign-registry.js finds the engine package with no
#   symlink of its own -- the fix the `dev` target still needs, made unnecessary by layout.
WORKDIR /app
COPY --from=deps /app/engine/src/engine engine/src/engine
COPY --from=deps /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
# Not just for `npm run migrate`: as the nearest ancestor manifest to dist/, its
# "type": "module" is what makes Node treat the emitted tree as ESM rather than CommonJS.
COPY server/package.json server/package.json
COPY server/migrations server/migrations

COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# node-pg-migrate reads `migrations/` relative to the working directory.
WORKDIR /app/server

ENV NODE_ENV=production
ENV PATH=/app/server/node_modules/.bin:$PATH
# tsconfig.build.json's rootDir spans server/src and shared/, so index.js lands two levels
# down inside dist/. Kept here rather than in a package.json script so the layout stays a
# property of the image and never leaks into either compose file.
ENV ADVENTURES_SERVE_CMD="node dist/server/src/index.js"
ENV ADVENTURES_MAINTAIN_CMD="node dist/server/src/maintenance-cli.js"

# The base image's existing uid-1000 `node` user. Everything above is root-owned and only
# ever read, and this process writes nothing to disk -- all state is in Postgres.
USER node

EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve"]
