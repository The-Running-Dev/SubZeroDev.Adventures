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
public/campaigns/       generated campaign JSON, committed — see "Campaign content" below
src/
  main.tsx, index.css, site.css, shared.tsx    app shell
  play/                  the game itself: PlayApp.tsx, composition.ts, browser-client.ts, play.css
  test/                  jsdom + real-browser test setup and shared assertion helpers
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
  Node-only import into a browser bundle.
- **Two of the exports this repo depends on are marked non-contract upstream**:
  `fromPortable` and the `Portable*` types, in `engine/src/engine/src/index.ts` (comment:
  `// SPIKE: runtime campaign loading … not a contract export`). A submodule bump can change
  or remove either without an upstream deprecation cycle. If a bump breaks
  `src/play/composition.ts` on this boundary, that is expected risk, not a bug to route
  upstream as-is — check whether the upstream shape genuinely changed before assuming this
  repo regressed.

## Campaign Content

`public/campaigns/*.json` (9 campaigns + `manifest.json`) is **generated, but committed** —
the site fetches it at runtime (`src/play/composition.ts`), it is not bundled. Regenerate with:

```bash
npm run sync:campaigns
```

This runs the engine submodule's own exporter (`engine/src/engine/scripts/spike-export-campaigns.ts`,
itself marked a throwaway spike upstream) and copies its output here — see
`scripts/sync-campaigns.mjs` for why it copies rather than pointing the exporter's hardcoded
output path at this repo. CI runs this and fails the build if it produces a diff
(`.github/workflows/ci.yml`, "Verify campaign content is not stale") — a silent content
change shipping to players is exactly the failure mode that check exists to catch.

## Visual Baselines — The One Real Gotcha

`src/play/browser/__screenshots__/visual-baseline.browser.test.tsx/` holds 32 PNGs: 16
snapshots × two platform suffixes (`chromium-win32`, `chromium-linux`). **CI runs on
`ubuntu-latest` with Playwright's managed Chromium** — only the `-linux` set is ever compared
there. If a UI change legitimately changes rendered output, regenerate locally:

```bash
npm run test:browser:update
```

This updates whichever platform suffix matches your machine. To regenerate the
`chromium-linux` set from Windows (needed before most PRs, since CI only checks that set),
run it inside a Linux container so the pixels actually match what CI will compare against.

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

`npm run test:browser` needs a real Chromium and a listenable local port; if your environment
sandboxes local sockets, run it inside the Playwright Docker image instead (see "Visual
Baselines" above) — that is also how CI runs it.
