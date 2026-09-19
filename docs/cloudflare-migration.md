# Cloudflare Pages migration

Status: prepared, **not deployed or cut over**. PR 3 stays draft until the live
checks below pass. PWA work follows the completed migration.

## Build and routing

`npm run build:cloudflare` creates `dist-cloudflare/` from the verified production
build. `dist/` remains the GitHub Pages artifact during the transition. The
[Worker](../hosting/cloudflare/worker.mjs) handles all requests; only HTML document
navigations to non-resource paths receive the application shell. The existing API
stays at `https://adventures-api.subzerodev.com`. No API proxy or private caching is
introduced. Missing resources return plain 404s, hashed assets cache immutably,
and HTML, manifests and service-worker files revalidate.

The generated plain `404.html` disables Cloudflare's implicit catch-all. It has
no redirect code. Do not remove this generated file: otherwise the asset binding
can turn missing resources into a successful shell before the Worker sees a 404.
The source GitHub redirect and URL repair remain until live verification succeeds.

References: [advanced-mode Worker and ASSETS binding](https://developers.cloudflare.com/pages/functions/advanced-mode/),
[Pages fallback behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/).

## Provision and preview

1. Create a Cloudflare Pages Direct Upload project, production branch `main`.
   Record its account, project name and deployment IDs in the PR evidence.
2. Configure the GitHub `cloudflare-pages` environment with secrets
   `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (account-scoped Pages Edit),
   and variable `CLOUDFLARE_PAGES_PROJECT`. Preserve the existing public build
   variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Leave repository variable `FRONTEND_HOST` unset. GitHub Pages continues serving
   production. Dispatch **Deploy Cloudflare Pages**, target `preview`, on this
   branch once the workflow is available. Before merging the workflow, the same
   reviewed artifact can be uploaded with an authenticated Wrangler installation:
   `wrangler pages deploy dist-cloudflare --project-name=<actual-project> --branch=migration-preview`.
4. Run `npm run verify:hosting -- https://<actual-deployment>.pages.dev/` and save
   the successful output with the exact commit/deployment ID. This performs
   repeated HTTP navigations, asset MIME/cache checks and fallback exclusion checks.
5. Bind a controlled sibling preview hostname under `subzerodev.com`, and add
   exactly that origin to the API's `PREVIEW_ORIGINS` for browser validation.
   Follow the existing [.env.example](../.env.example) contract. A `pages.dev`
   hostname is cross-site to the API's SameSite=Lax cookie, so successful static
   checks there do not prove signed-in API behavior. Do not weaken cookie policy
   or allow arbitrary preview origins to compensate.

References: [Direct Upload from CI](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/),
[custom-domain association before DNS](https://developers.cloudflare.com/pages/configuration/custom-domains/).

## Browser checks before cutover

Record pass/fail, browser, URL, commit and deployment ID for each row. HTTP smoke
checks cannot substitute for the authenticated flows.

| Check                     | Required observation                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct routes and refresh | `/profile`, `/ranking`, `/content`, `/start`, nested discussion/profile routes and OAuth consent load without a 404 redirect; browser refresh retains path/query/hash.                                   |
| Legacy campaign URL       | `/?campaign=<existing-id>` still selects the intended campaign. `/play/<id>` returns the shell now; player route implementation is PR 7.                                                                 |
| API/CORS                  | Requests target the existing API origin; credentialed allowed-origin responses work; an unlisted origin remains rejected.                                                                                |
| Guest and member identity | Start a guest run, refresh/resume, sign in, inspect progress, sign out; account data clears and cookies remain API-host-only, Secure, HttpOnly, SameSite=Lax.                                            |
| OAuth                     | Existing provider start/callback completes, returns to canonical `SITE_URL`, preserves guest progress; consent deep link works. Preview sign-in returning to production is the existing server contract. |
| Navigation and assets     | No document reload for internal links; JS/CSS/images have correct MIME; missing files/API paths remain errors.                                                                                           |
| TLS and caching           | Valid certificate on preview and final custom domain; shell revalidates; immutable hashed assets; no custom CDN cache rule overrides the Worker.                                                         |
| Service-worker boundary   | No registration is added in this PR; missing SW/manifest requests are errors and future root files are served from `/` without redirects. Actual SW scope/update checks belong to PR 4.                  |

## Cutover, compatibility cleanup and rollback

1. Save the current DNS record **including target, proxy state and TTL**, the
   current GitHub Pages deployment SHA, and the API environment values. Do not
   substitute a guessed GitHub DNS target in the rollback record.
2. Merge PRs 1–2 in order, preserving the intended stacked changes. Keep this
   migration PR draft. Upload its tested candidate artifact with Wrangler's
   `--branch=main` to Cloudflare production while GitHub remains available.
   Record the candidate SHA; it is not yet the repository's main SHA.
   Associate `adventures.subzerodev.com` with that Pages project before
   changing its DNS record. Confirm certificate activation.
3. Point the frontend hostname to the verified Pages project. Keep `SITE_URL`,
   `API_URL`, API hosting and provider callback configuration unchanged. Repeat
   the HTTP script and all browser checks on the canonical hostname.
4. Only after those checks pass, remove `public/404.html` and the `spa_redirect`
   repair script from `index.html`, and remove/update their route compatibility
   tests. Keep the generated plain Cloudflare 404 guard. Rebuild, redeploy and
   repeat direct-route, refresh and OAuth checks before completing PR 3.
5. Before merging this PR, set repository `FRONTEND_HOST=cloudflare` to enable
   automatic Cloudflare production deployment and disable the GitHub deployment
   job. This preserves the last GitHub-compatible deployment when the cleanup
   commit merges. Record the live verification evidence, mark this PR ready,
   merge, and confirm the automatic Cloudflare deployment of that exact main SHA.

For rollback, stop new Cloudflare deploys, restore the saved DNS record and clear
`FRONTEND_HOST`. Restore the saved GitHub-compatible source SHA (with its redirect
workaround) through the normal reviewed branch workflow before resuming GitHub
deployments; simply deploying the later Cloudflare-only source to GitHub breaks
deep links. Confirm the saved GitHub deployment serves the restored hostname,
then repeat identity and deep-link checks. Leave the API database and identity
configuration untouched. Remove any temporary preview CORS origin after the
migration validation period. A rollback is not verified until these observations
have been recorded; this document does not claim a rehearsal occurred.
