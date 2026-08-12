# Project Instructions

## What This Project Is

**SubZeroDev.Adventures** — the standalone browser play surface for
[SubZeroDev Game Engine](https://github.com/The-Running-Dev/SubZeroDev.GameEngine) campaigns.
This is a **client repository**, not a spec repository: it has no `design/` folder, no
brief/design/contract/slices pipeline, and no canonical engine contract of its own. The
contract lives upstream; this repo consumes it across a repository boundary.

It was extracted from the engine repository's `site/play/` route (see
[`plans/`](../SubZeroDev.GameEngine/plans/spike-notes.md) there for the original W65 work).
The engine repository's `/play/` route may still exist for a transitional period — this repo
is the one going forward.

## Structure

```
engine/                 git submodule, the whole SubZeroDev.GameEngine repo, pinned by commit
  src/engine/            the npm package this site depends on (file:./engine/src/engine)
public/campaigns/       test-fixture campaign JSON, committed — see "Campaign content" below
src/
  main.tsx, index.css, site.css, shared.tsx    app shell
  play/                  the game itself: PlayApp.tsx, composition.ts, browser-client.ts, play.css
  test/                  jsdom + real-browser test setup and shared assertion helpers
shared/                 code both compositions import — environment-neutral, no DOM, no Node
server/                 the hosted Node API: its own npm project, its own Dockerfile
docker-compose.yml      the deployment stack — see "The Two Compose Files" below
```

## The Engine Submodule — What Not to Forget

- **`engine/` is the whole engine repository**, not just its npm package — git cannot
  submodule a subdirectory. The package lives at `engine/src/engine`.
- **`engine/src/engine/dist/` is gitignored, same as upstream.** A fresh clone has no built
  engine, so `npm install` alone does not work. Run `npm run setup` first (or just
  `npm install` — it runs as a `prepare` script and builds the submodule automatically).
- **Bumping the submodule pin is a real dependency upgrade**, not a formality. After moving
  `engine/` to a new commit: rebuild it (`npm run setup`), re-run
  `npm run sync:campaigns` and diff `public/campaigns/` for unreviewed content changes, and
  run the full `npm run check` gate — an engine change can change campaign content, validation
  behavior, or (per the browser-portability gate in `scripts/verify-build.mjs`) reintroduce a
  Node-only import into a browser bundle. It can also change the rendered UI enough to need
  new visual baselines — see "Visual Baselines" below.
- **The portable campaign format graduated out of spike status** (engine `0.6.0`):
  `fromPortable`, `digestPortableCampaign`, and the `Portable*` types are now real exports
  from `engine/src/engine/src/index.ts`, not disclaimed ones. `formatVersion` is `2`:
  `campaign.content` is a `kindId`-discriminated union instead of `unknown`, a manifest's
  `campaigns` entries carry `{file, id, version, digest}` instead of a bare filename, and
  `migration` moved from a sibling of `campaign` into the story-graph arm of the union. Both
  `server/src/campaigns/source.ts` and `src/play/composition.ts` verify each fetched
  campaign against its manifest entry's digest (`digestPortableCampaign`) before trusting it.

## Campaign Content

`public/campaigns/*.json` (9 campaigns + `manifest.json`) is **test-fixture content, not a
runtime source.** The deployed server's only campaign source is
[`The-Running-Dev/SubZeroDev.Adventures.Content`](https://github.com/The-Running-Dev/SubZeroDev.Adventures.Content)
(hardcoded in `server/src/index.ts`, served over GitHub Pages), and the deployed site always
sets `VITE_API_URL` so the browser never falls back to local files either (`src/play/composition.ts`).
What lives here backs `browser-client.test.ts`, `PlayApp.test.tsx` (both import these files as
fetch-stub fixtures), the visual-regression baselines, and `buildApp`'s disk-backed default
`campaignSource` (`server/src/app.ts`) that the rest of the server test suite runs against.
Regenerate with:

```bash
npm run sync:campaigns
```

This runs the engine submodule's own exporter (`engine/src/engine/scripts/export-campaigns.ts`,
graduated out of spike status alongside the portable format) and copies its output here — see
`scripts/sync-campaigns.mjs` for why it copies rather than pointing the exporter's hardcoded
output path at this repo. Nothing enforces that this stays in lockstep with the engine or with
`SubZeroDev.Adventures.Content` — it is a fixture snapshot now, not shipped content, so it is
free to drift until a test actually needs the refresh. Diff the result after running it, and
regenerate the visual baselines (below) if rendered output changed.

## The Two Compose Files

There are two, they are independent, and neither is an override layer over the other. This
mirrors how `SubZeroDev.com` and `SubZeroDev.Blog/tools/blog-mcp` are laid out.

- **`docker-compose.yml` (root) is the deployment stack.** It pulls
  `ghcr.io/the-running-dev/adventures-api` and builds nothing. Requires a `.env` beside it
  (copy `.env.example`) and a pre-existing external `proxy-net` network — TLS and public
  routing belong to whatever reverse proxy already lives on that network, not to this repo.
- **`server/docker-compose.yml` is the dev stack.** `build: context: ..` — the context is
  the repo root, because the image needs `engine/`, `shared/`, and `server/`. Its image is
  tagged `subzerodev-adventures-api:dev`, deliberately never the GHCR name.

```bash
docker compose -f server/docker-compose.yml up -d --build
```

Both files say `command: serve` and `command: migrate`. Those are
`server/docker-entrypoint.sh`'s vocabulary, not paths — the `dev` target reaches them via
`tsx` from source and `runtime` via emitted JS in `dist/`, and neither compose file knows
which. Set `ADVENTURES_DB_PORT` if 5432 is already taken locally.

### What the Dockerfile's layout is actually protecting

`server/Dockerfile` reproduces the repository's directory structure inside the image rather
than flattening it, for two reasons that are easy to break and hard to diagnose:

- **The engine dependency is a symlink.** npm stores `file:` dependencies as a symlink
  whose target is relative to its own location. Moving either `server/node_modules` or
  `engine/src/engine` breaks it. (`--install-links` avoids symlinks, but the committed
  lockfile is a symlink-mode lockfile and `npm ci` rejects the mismatch.)
- **`shared/` and `server/` are siblings.** Node and tsc both resolve dependencies by
  walking `node_modules` up through a file's _ancestors_, so `server/node_modules` is never
  on `shared/campaign-registry.ts`'s path. The `build` and `dev` targets add
  `ln -s server/node_modules node_modules` for this; `.github/workflows/ci.yml` carries the
  same line for the same reason. The `runtime` target needs no symlink only because it puts
  `dist/` _under_ `server/`, making `server/node_modules` a genuine ancestor.

`public/campaigns/` is not copied into either image target — the deployed server has no disk
content source (see "Campaign Content"), so there is nothing there for `CAMPAIGNS_DIR` to
point at.

## Visual Baselines — The One Real Gotcha

`src/play/browser/__screenshots__/visual-baseline.browser.test.tsx/` holds 16 PNGs, one per
snapshot, all suffixed `chromium-linux`. **CI runs on `ubuntu-latest` with Playwright's
managed Chromium** and that `-linux` set is the only baseline the repo maintains — no
`chromium-win32` set is committed. `vitest.browser.config.ts` excludes
`visual-baseline.browser.test.tsx` from the run when `os.platform() === "win32"` (checked at
config load, in Node — the spec file itself also runs inside the real browser tab it tests
in, where there is no equivalent platform check), so running `npm run test:browser` natively
on Windows silently skips these specs instead of failing on baselines that don't exist for
that platform. That means a Windows contributor gets no local visual-regression signal before
pushing — the tradeoff for not having to keep two baseline sets in sync — so treat CI as the
first real check for a visual change made on Windows.

If a UI change legitimately changes rendered output, regenerate the `chromium-linux` set from
Windows (there is no other set to regenerate) by running it inside a Linux container so the
pixels actually match what CI will compare against:

```bash
npm run test:browser:update
```

**Use a plain `node:24` image with `playwright install --with-deps`, not the
`mcr.microsoft.com/playwright` image** — its bundled Chromium build renders text a few
pixels taller at every non-320px width than the Chromium `playwright install --with-deps`
downloads on `ubuntu-latest`, which is exactly the mismatch that broke this repo's first CI
run (baselines that passed locally under the Microsoft image failed in CI). Match what the
workflow actually does:

```bash
docker run --rm -v "${PWD}:/w" -w /w node:24 \
  bash -c "npm ci && npx playwright install --with-deps chromium && npm run test:browser:update"
```

Commit both the regenerated PNGs and the source change together — a screenshot diff with no
accompanying code change, or vice versa, is a review red flag.

## The Identity Seam — A Contract Platform Is Building From

`SubZeroDev.Platform` is designing its own identity package by reading this repo's, not
in the abstract (`SubZeroDev.Platform` `design/90-decisions.md`,
The-Running-Dev/SubZeroDev.Platform#90). That only holds if these five properties keep
holding — they're about staying _readable as a contract_, a different goal from staying
correct, and one that can erode without any test failing. Check a change against these
before assuming server-side identity/session work is done:

- Adding a sign-in provider is a new file implementing `IdentityProvider`
  (`server/src/identity/provider.ts`), not a new design. `server/src/identity/oidc.ts` is
  the one provider today, fully generic — no vendor named in its code.
- There is exactly one place a request becomes a player: `requirePrincipal`/
  `resolvePrincipal` in `server/src/principal.ts`. Nothing else mints or resolves one.
- No provider name (`github`, `supabase`, …) appears outside `server/src/identity/` or
  environment configuration — `server/src/identity/registry.ts` assembles providers from
  env vars, naming Supabase only in a comment. A grep for a vendor name landing in
  `principal.ts` or a route file is a regression, unless it's prose explaining history (as
  in `principal.ts`'s comments on the old GitHub-specific column).
- Nothing durable about a player's permissions or access is stored in the session cookie —
  it carries an opaque token; `auth_sessions` is looked up fresh on every request.
- Accounts are matched on `(provider, subject)` (`migrations/007_identities.sql`'s primary
  key), never on email — there is no email column on `identities`.
- Ownership is enforced at a store decorator (`server/src/store/ownedStore.ts`), not
  per-route — this was the one property that didn't hold as of issue #6; keep it that way
  rather than letting a new guarded route reach back for a per-route preHandler instead.

## User-Submitted Content

A signed-in player can submit their own campaign or extension (`/content`,
`server/src/routes/content.ts`) — playable by them immediately, privately; an admin's approval
(`routes/admin.ts`'s queue) is what makes it public. `content_sources` (migration 011) holds
both admin-curated rows (`owner_player_id null`, always `approved`/`public` — migration 013's
`content_sources_owner_shape` constraint enforces this in the schema) and player submissions.

- **Two tiers, two failure postures.** The trusted tier (builtin + admin rows,
  `campaigns/multi-source.ts`) stays exactly as fail-closed as before this feature existed: one
  bad admin source still aborts the whole refresh. The submission tier
  (`campaigns/submissions.ts`) is fail-open per row — `shared/campaign-registry.ts`'s
  `buildTieredCatalog` quarantines a colliding or broken submission and still publishes
  everything else, using a greedy incremental build (not two independent probes) so a
  collision _between_ two submissions — an unnamespaced string key each defines differently,
  say — is still attributed to a specific row.
- **A submitted extension may only extend a campaign its own author also submitted** — enforced
  in `campaigns/submissions.ts` — because `mergeExtensions` mutates its base campaign in place
  before validation, so there is no way to filter one per-viewer after the fact. Extending core
  content stays admin-only.
- **The engine's own `getStrings` has no per-campaign partition** — it returns the whole merged
  registry string table for any session. `ServerDemo.stringsFor` (`composition.ts`) and
  `ownedStore.getStrings` narrow that to the session's own campaign before it reaches a player,
  closing what would otherwise be every private submission's narrative text leaking to anyone
  with an active session.
- **Platform-wide aggregates read `ServerDemo.core`, never `.all`.** Badges, public profile
  stats, the leaderboard, and rarity/median baselines
  (`badges.ts`/`routes/profile.ts`/`ranking.ts`/`platform-baselines.ts`) are all scoped to core
  content — otherwise a player could shift their own badge eligibility, win "rarest ending" by
  construction, or farm the leaderboard by publishing their own campaign. `routes/stats.ts`'s
  `campaignsPlayed` is the one deliberate exception: a plain growing count, not a denominator or
  a score.
- **Player-submitted `url` sources go through `campaigns/safe-fetch.ts`**, not the plain global
  `fetch` an admin's URL source uses — https-only, refuses a resolved private/loopback/link-local
  address, no redirects, a capped response body. A DNS answer that changes between that check
  and the actual connect (rebinding) is a known, accepted gap — see the file's own header.

### Admin bootstrap

Admin access is `players.role = 'admin'` (migration 012), not an env var. The first admin (any
deployment) is granted once, out of band:

```bash
npm run grant-role --prefix server -- <provider> <subject> admin
```

or, against the deployed image directly: `docker compose run --rm api node
dist/server/src/grant-role-cli.js <provider> <subject>`. The target player must already exist
(have signed in at least once, so an `identities` row links them) — this does not mint one.
Every admin after the first is granted from the admin page itself
(`POST /api/admin/players/role`).

## House Conventions

- Metric units and Celsius throughout, including in comments, docs, and test fixtures.
- Raster assets as PNG or JPG. Not WebP.
- **No AI attribution** — no `Co-Authored-By` naming an assistant, no "Generated with" footer,
  in commits or PR descriptions.
- **Stage explicitly, by named path.** Never `git add -A`, `git add .`, or a bare directory —
  `engine/` alone makes a broad add dangerous, since a stray `git add -A` inside a dirty
  submodule checkout can stage submodule-internal changes this repo does not own.
- **Never force-push or rewrite published history** on `main`.

## Validation

```bash
npm run setup           # build the engine submodule (only needed after a fresh clone or a submodule bump)
npm run check            # format:check, lint, typecheck, test, test:browser, test:build
npm run sync:campaigns && git diff --exit-code -- public/campaigns   # campaign drift
```

`server/` is a separate npm project and `npm run check` does not reach into it — CI runs it
as its own job. Validate it directly:

```bash
npm run typecheck --prefix server && npm run build --prefix server && npm test --prefix server
```

`npm test --prefix server` skips its integration suite unless `DATABASE_URL` is set; bring
up `server/docker-compose.yml` first to have something for it to point at.

`npm run test:browser` needs a real Chromium and a listenable local port; if your environment
sandboxes local sockets, run it inside the Playwright Docker image instead (see "Visual
Baselines" above) — that is also how CI runs it.
