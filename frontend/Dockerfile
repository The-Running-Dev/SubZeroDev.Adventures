# syntax=docker/dockerfile:1
# Repository-root context, matching the API image and engine submodule layout.
ARG NODE_IMAGE=node:24-bookworm-slim
ARG CADDY_IMAGE=caddy:2-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY engine/src/engine/package.json engine/src/engine/package-lock.json engine/src/engine/
RUN npm ci --prefix engine/src/engine
COPY engine/src/engine engine/src/engine
RUN npm run build --prefix engine/src/engine
COPY package.json package-lock.json ./
# The engine was built above; do not run the root prepare hook a second time.
RUN npm ci --ignore-scripts
COPY tsconfig*.json vite.config.ts index.html ./
COPY src src
COPY shared shared
COPY public public
COPY scripts scripts
ARG VITE_API_URL=https://adventures-api.subzerodev.com
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG ADVENTURES_BUILD_REVISION=development
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
RUN npm run test:build \
    && rm -f dist/404.html \
    && printf '%s\n' "$ADVENTURES_BUILD_REVISION" > dist/__build-id

FROM ${CADDY_IMAGE} AS runtime
ARG ADVENTURES_BUILD_REVISION=development
LABEL org.opencontainers.image.revision=${ADVENTURES_BUILD_REVISION}
LABEL org.opencontainers.image.source=https://github.com/The-Running-Dev/SubZeroDev.Adventures
COPY frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/__build-id || exit 1
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
