# Frontend hosting on the existing VPS

The frontend follows the API's existing GitOps deployment: GitHub Actions builds
and publishes to GHCR, then triggers the same Portainer stack webhook. There is
no Cloudflare Pages project, Wrangler dependency, new stack or new deploy secret.

## Deployment contract

- `frontend/Dockerfile` builds the engine and Vite application, then copies only
  static output into Caddy. Node and API credentials are absent from the runtime.
- `.github/workflows/deploy-api.yml` publishes `adventures-api` and
  `adventures-web` with immutable commit tags and `:latest`. It tests the exact
  frontend image before publishing and waits for both images before calling the
  existing `PORTAINER_REDEPLOY_WEBHOOK_URL`, gated by existing `DEPLOY_ENABLED`.
  Workflow concurrency prevents overlapping runs from racing the moving tags.
- Root `docker-compose.yml` remains the existing Portainer Git stack. Its new
  `frontend` service pulls `ghcr.io/the-running-dev/adventures-web:latest`, is
  named `adventures-web`, and listens on HTTP port 8080 on `proxy-net`. It has no
  host port or connection to the database network. The existing API/database
  services, volume and stack name retain their identities.
- The existing reverse proxy owns TLS. Its frontend upstream is
  `http://adventures-web:8080`; the API upstream remains unchanged.
- Public build configuration uses the existing GitHub variables
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, with
  `VITE_API_URL=https://adventures-api.subzerodev.com`. These are build arguments,
  not Portainer runtime settings. Changing them requires rebuilding the image.
- `GET /__build-id` returns the image's source commit without caching. Both the
  Docker healthcheck and external deployment verification use this endpoint.

The static server rewrites only HTML application navigations. Missing assets,
SW files, manifests and API resources return errors. The site root is served as a
file, so `/` answers every client -- uptime monitors, link-unfurl bots and `*/*`
crawlers included -- without depending on navigation headers; a deeper route still
requires an HTML navigation. A route segment containing a dot is read as a resource
and returns 404, which is why `/u/<slug>` (base64url) and `/discussions/<id>`
(`[A-Za-z0-9_-]`) are safe: a future `/play/<campaign-id>` must stay dot-free too. Existing hashed bundles
cache immutably; HTML, service workers and manifests revalidate. The API is not
proxied through this container. See [Caddy's SPA pattern](https://caddyserver.com/docs/caddyfile/patterns#single-page-apps-spas)
and the stricter matchers in [frontend/Caddyfile](../frontend/Caddyfile).

## First rollout

1. Merge the prerequisite frontend PRs in order, then this deployment change.
   The existing workflow publishes both images and invokes the configured stack
   webhook. Confirm Portainer refreshed its Git checkout and shows the new
   `frontend` service with a healthy `adventures-web` container. A webhook 2xx
   alone is not proof that the stack applied the new Compose file.
2. Preserve the current frontend DNS/proxy settings and GitHub Pages deployment
   SHA. Configure the existing reverse proxy for `adventures.subzerodev.com` to
   use `adventures-web:8080`, with HTTPS, and point frontend DNS at the VPS if it
   currently resolves to GitHub Pages. Do not change the API origin, `SITE_URL`,
   identity callback URLs or cookie policy.
3. Check the image's `/__build-id` matches the deployed source SHA. Run:

   ```bash
   EXPECTED_BUILD_REVISION=<full-source-sha> npm run verify:hosting -- https://adventures.subzerodev.com/
   ```

   This repeats the same 35 HTTP checks used against the container in CI. It
   requires HTTPS for a public host and rejects an old build or broken fallback.

4. Verify browser refresh and query/hash preservation on `/profile`, nested
   discussions, `/u/<slug>`, `/oauth/consent`, and `/?campaign=<existing-id>`.
   `/play/<id>` receives the shell now; the player route itself arrives in PR 7.
   Test guest play/resume, member sign-in/progress/sign-out, credentialed API
   calls, consent and OAuth return. Confirm the existing allowed-origin CORS
   behavior and API-host-only Secure/HttpOnly/SameSite=Lax cookies.
5. After the canonical hostname passes, set GitHub repository variable
   `FRONTEND_HOST=vps`. This stops future GitHub Pages deployments and enables
   external frontend verification after subsequent Portainer webhook calls.
   No new deployment credential is required.
6. Record the tested SHA, TLS/routing/auth results and rollback target in PR 3.
   Only then remove the source `public/404.html` and the `spa_redirect` repair
   from `index.html`, update their tests and verify again. The container already
   excludes the redirect 404; source compatibility stays for GitHub during the
   transition. PWA work follows the verified host migration.

## Validation and rollback

CI builds the actual image and starts it with the same read-only filesystem,
non-root user and capability restrictions as Compose. It waits for its Docker
healthcheck, then runs `frontend/hosting.test.mjs` against the live Caddy server.
The release workflow repeats that check before pushing the image.

For a frontend-only rollback, set Portainer's `ADVENTURES_FRONTEND_IMAGE` to
`ghcr.io/the-running-dev/adventures-web:<known-good-sha>` and redeploy the existing
stack. Confirm `/__build-id`, direct routes and identity behavior. The API has its
separate `ADVENTURES_API_IMAGE` pin; a frontend rollback requires no DB change.
Remove the frontend pin to resume following `:latest` after recovery.

For an initial-host migration rollback, restore the recorded DNS/proxy settings
and the last known-good GitHub Pages deployment. Clear `FRONTEND_HOST` before
resuming GitHub deployment, and restore a GitHub-compatible source revision if
redirect cleanup has already merged. Never guess the former DNS target.

Live VPS rollout, reverse-proxy/DNS cutover and browser identity checks are not
claimed by passing container CI. Record them against the actual deployed SHA.
