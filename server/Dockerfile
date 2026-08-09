# Build context is the repo root (docker-compose.yml: `context: .`) -- this image needs
# engine/, shared/, public/campaigns/, and server/, the same four things
# server/src/composition.ts and shared/campaign-registry.ts reach across at runtime.
#
# `tsx` runs the server's TypeScript directly, in the container as in dev -- no separate
# build step. See CLAUDE.md's plan note: "if this graduates past POC, swap tsx for a
# build step."
FROM node:24 AS dev
WORKDIR /app

# `shared/campaign-registry.ts` uses `import`/`export` syntax with no closer package.json
# of its own -- Node resolves a file's module type (ESM vs CJS) from the nearest ancestor
# package.json, and without one here it would fall back to CJS, which cannot resolve the
# engine package's ESM-only `exports` map (`"import"` condition, no `"require"`). The host
# repo never hits this because its own root package.json (`"type": "module"`) is already
# an ancestor of `shared/`; this image has no such root, so it gets a minimal one purely to
# supply that declaration.
RUN echo '{"type":"module"}' > package.json

# The engine submodule's dist/ is gitignored even inside the submodule itself (CLAUDE.md,
# "The Engine Submodule") -- a fresh image build must build it before `server`'s
# `file:../engine/src/engine` dependency has anything to resolve to, the same as
# scripts/setup-engine.mjs does for a local checkout.
COPY engine/src/engine/package.json engine/src/engine/package-lock.json engine/src/engine/
RUN npm ci --prefix engine/src/engine
COPY engine/src/engine engine/src/engine
RUN npm run build --prefix engine/src/engine

COPY shared shared
COPY public/campaigns public/campaigns

COPY server/package.json server/package-lock.json server/
RUN npm ci --prefix server
COPY server server

# `shared/campaign-registry.ts` imports `@the-running-dev/game-engine`. Node's module
# resolution walks up from a file's own directory through *its ancestors'* node_modules --
# `/app/shared` and `/app/server` are siblings, not ancestor/descendant, so
# `server/node_modules` alone is never on that path. This symlink puts it on the path
# without a second install; the host repo doesn't need the same fix only because a root
# `npm install` there happens to leave a root `node_modules` in the way.
RUN ln -s server/node_modules node_modules

WORKDIR /app/server
EXPOSE 8787
CMD ["npm", "run", "start"]
