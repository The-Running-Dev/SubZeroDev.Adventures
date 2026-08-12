# Previewing UI changes without the CI round-trip

The deployed site is a GitHub Pages build off `main` (`.github/workflows/deploy.yml`). That
path is fine for shipping and bad for iterating: even at its measured ~50s it means a
commit, a push, and a wait for every adjustment to a margin. Worse, a UI change made on
Windows gets no local visual-regression signal at all (see "Baselines" below), so the first
thing that notices a rendered-output change is CI, one push later.

This document covers the two loops that avoid that, and the one thing that makes the
CI round-trip cheap when you do have to take it.

Nothing here changes how the site deploys. `deploy.yml` is untouched, and no preview build
can become the deployed one — different host, different stack, different bundle.

## The two loops

|                                             | latency         | real domain | signed-in session | needs           |
| ------------------------------------------- | --------------- | ----------- | ----------------- | --------------- |
| **Tunnel** (`npm run dev` + a tunnel)       | HMR, sub-second | yes         | yes               | a tunnel client |
| **Preview host** (`npm run deploy:preview`) | ~25s            | yes         | yes               | a VPS container |

Use the tunnel while you are actively editing. Use the preview host when you want a URL
that stays up after you close the laptop — showing someone, testing on a phone you don't
want to keep tethered, or leaving something running overnight.

## Both loops need this first: `PREVIEW_ORIGINS`

The API allows exactly one browser origin through CORS, and refuses any write from an
unrecognized `Origin` outright (`server/src/app.ts`). A preview served from anywhere other
than `SITE_URL` therefore loads fine and then fails every call it makes, which looks like a
broken build rather than a configuration gap.

Set `PREVIEW_ORIGINS` on the deployed API to the preview origin (comma-separated for more
than one), and restart it:

```bash
docker compose up -d api
```

Two properties worth understanding before choosing a hostname:

- **Every origin listed can write as the signed-in player**, not merely read. That is
  deliberate — a preview that could read state but not save a game would be testing
  something other than what ships — but it means the list is for hosts you control.
- **Put the preview under `*.subzerodev.com` if you want sign-in to work.** The session
  cookie is host-only on the API's domain with `SameSite=Lax` (`server/src/principal.ts`),
  so a sibling subdomain still sends it and `http://localhost:5173` does not. A localhost
  preview is anonymous play only.

Sign-in _initiation_ always returns you to `SITE_URL`: the OAuth callback redirects there
by construction (`server/src/routes/identity.ts`), and that is intentionally not something
`PREVIEW_ORIGINS` widens. Sign in on the real site once; the preview inherits that session
because it is the same cookie on the same API.

## Loop 1 — the tunnel

Run the dev server against the deployed API:

```bash
VITE_API_URL=https://adventures-api.subzerodev.com npm run dev
```

Then expose it at the preview hostname. Either client works; both give you a stable name
without opening a port on your machine:

```bash
cloudflared tunnel --url http://localhost:5173 --hostname dev.adventures.subzerodev.com
```

```bash
tailscale funnel 5173
```

Add `--host` to the Vite command if the tunnel client cannot reach a loopback-bound server.
You now have HMR — sub-second, no build, no upload — on a real hostname, with a real
session, testable from a phone.

This is the loop to reach for by default. The preview host below exists for what it can't
do: outlive the terminal it's running in.

## Loop 2 — the preview host

A static file server on the VPS, and a script that builds locally and ships the result.
No git, no webhook, no remote build — the machine that already has warm `node_modules` and
a built engine submodule is the fastest place to build, and a webhook-on-push loop would
add a commit to every iteration to buy nothing.

### One-time setup on the VPS

```bash
mkdir -p /srv/adventures-preview/releases
chown -R "$USER" /srv/adventures-preview
docker compose -f preview/docker-compose.yml up -d
```

Point the reverse proxy on `proxy-net` at `adventures-preview:8080` for
`dev.adventures.subzerodev.com`, the same way it already routes the API. The directory must
exist and be owned by the SSH user before the container starts — Docker would otherwise
create it root-owned and every deploy would fail on permissions.

### One-time setup locally

Create `.env.preview` (git-ignored):

```bash
PREVIEW_SSH_HOST=vps
PREVIEW_API_URL=https://adventures-api.subzerodev.com
```

`PREVIEW_SSH_HOST` is anything `ssh` accepts — a `Host` alias from `~/.ssh/config` is the
better answer, since it keeps the key path and port out of this repo. The optional rest:

| variable                    | default                   |                                                            |
| --------------------------- | ------------------------- | ---------------------------------------------------------- |
| `PREVIEW_REMOTE_ROOT`       | `/srv/adventures-preview` | must match the bind mount in `preview/docker-compose.yml`  |
| `PREVIEW_KEEP_RELEASES`     | `5`                       | previous releases left on the VPS for a manual roll-back   |
| `PREVIEW_SUPABASE_URL`      | unset                     | leave unset to preview the "identity not configured" state |
| `PREVIEW_SUPABASE_ANON_KEY` | unset                     |                                                            |

### Then, for every iteration

```bash
npm run deploy:preview
```

Builds, uploads one tarball, unpacks it into `releases/<timestamp>-<sha>`, and swaps a
symlink. The swap is a rename, so a visitor mid-deploy gets either the old build or the new
one and never a directory being replaced under them.

**Open tabs reload themselves within ~3s.** The preview build — and only the preview build
— carries a small script that polls `__build-id` and reloads when it changes
(`vite.config.ts`'s `preview-reload`, gated on `PREVIEW_RELOAD=1`, which nothing in
`deploy.yml` sets). The reload is a real page load, not HMR: state is lost, which for a
save-backed game is usually what you want anyway.

To roll back, re-point the symlink by hand:

```bash
ssh vps 'ln -sfn releases/<id> /srv/adventures-preview/current.tmp && mv -Tf /srv/adventures-preview/current.tmp /srv/adventures-preview/current'
```

## Baselines — the other half of the wait

Neither loop above touches the visual-regression baselines, and those are the most common
reason a UI change costs two pushes instead of one.
`src/play/browser/__screenshots__/` holds a `chromium-linux` set only;
`vitest.browser.config.ts` skips those specs on win32, so a Windows checkout gets no local
signal and CI fails on the first push.

Regenerate before pushing, in one command:

```bash
npm run baselines:update
```

It runs the browser suite inside a `node:24` container — the same image CI's Chromium comes
from, which is load-bearing (`mcr.microsoft.com/playwright`'s bundled Chromium renders text
taller and produces baselines that pass locally and fail in CI). The host's `node_modules`
is shadowed by an anonymous volume, so this does not replace your Windows-native binaries
with Linux ones. Commit the regenerated PNGs together with the change that caused them.

If you only find out from CI, the **Update visual baselines** workflow now commits the
regenerated set back to the branch rather than handing you an artifact to copy by hand —
one click instead of a download, a copy, and a second push.
