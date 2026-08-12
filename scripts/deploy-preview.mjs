/**
 * Builds the site and ships it straight to the VPS preview host -- no commit, no push, no
 * GitHub Actions, no Pages CDN. `npm run deploy:preview`, roughly 25 seconds.
 *
 * This deliberately does NOT go through git. The webhook-on-push shape that prompted it
 * (push -> webhook -> remote `npm ci` + engine build -> swap) is strictly slower than
 * building on the machine that already has warm `node_modules` and a built engine, and it
 * forces a commit for every one-line CSS tweak. The tradeoff is that the preview host has
 * no idea what commit it is serving -- that is what `__build-id` records, and why the id
 * is the local HEAD sha plus a dirty marker rather than a bare timestamp.
 *
 * Releases are uploaded whole and swapped by relocating a symlink, so a visitor mid-deploy
 * either gets the old build or the new one, never a directory half-replaced under them.
 * `preview/docker-compose.yml` is the static host that serves the symlink.
 *
 * Configuration comes from a git-ignored `.env.preview` (loaded here) or the real
 * environment. See docs/preview.md.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const envFile = join(repoRoot, ".env.preview");
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** `spawnSync` with a non-zero exit turned into a throw -- `execFileSync`'s behaviour, but
 *  reachable with a custom stdio array (which `execFileSync` will not take an fd in). */
function run(command, args, stdio) {
  const result = spawnSync(command, args, { stdio });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  }
}

function required(name, hint) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Put it in .env.preview (git-ignored) or the environment.\n  ${hint}`,
    );
  }
  return value;
}

// `user@host`, or a Host alias from ~/.ssh/config -- whatever `ssh` itself accepts. An
// alias is the better answer: it keeps the key path and port out of this repo entirely.
const sshHost = required(
  "PREVIEW_SSH_HOST",
  "e.g. PREVIEW_SSH_HOST=vps  (a Host alias in ~/.ssh/config)",
);
// Must match the bind mount in preview/docker-compose.yml.
const remoteRoot = process.env.PREVIEW_REMOTE_ROOT ?? "/srv/adventures-preview";
// The deployed API this preview build talks to. Its origin must be listed in the server's
// PREVIEW_ORIGINS, or every call the preview makes is a CORS failure (server/src/app.ts).
const apiUrl = required(
  "PREVIEW_API_URL",
  "e.g. PREVIEW_API_URL=https://adventures-api.subzerodev.com",
);
// How many previous releases to leave on the VPS for a manual roll-back.
const keepReleases = Number(process.env.PREVIEW_KEEP_RELEASES ?? 5);

const git = (args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const sha = git(["rev-parse", "--short", "HEAD"]);
// Uncommitted work is the normal case for this loop, not an anomaly -- the marker just
// stops a `__build-id` from claiming to be a commit it isn't.
const dirty = git(["status", "--porcelain"]) === "" ? "" : "-dirty";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
const releaseId = `${stamp}-${sha}${dirty}`;

console.log(`Building preview ${releaseId}`);
// Same reasoning as scripts/setup-engine.mjs: `npm` is a `.cmd` shim on Windows and cannot
// be launched by `execFileSync` without a shell, so go through npm's own JS entry point.
const npmCli = process.env["npm_execpath"];
if (!npmCli) {
  throw new Error(
    "npm_execpath is unset — run this through `npm run deploy:preview`, not `node` directly",
  );
}
execFileSync(process.execPath, [npmCli, "run", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_API_URL: apiUrl,
    VITE_SUPABASE_URL: process.env.PREVIEW_SUPABASE_URL ?? "",
    VITE_SUPABASE_ANON_KEY: process.env.PREVIEW_SUPABASE_ANON_KEY ?? "",
    // The one thing that distinguishes this bundle from the deployed one: vite.config.ts
    // injects the reload poll only when this is set.
    PREVIEW_RELOAD: "1",
  },
});

// Written after the build so it lands in the same directory the bundle did, and read by
// the injected poll. Its content is the only thing that has to change for every open tab
// to reload.
writeFileSync(join(repoRoot, "dist", "__build-id"), `${releaseId}\n`);

// Packed locally and sent as one file rather than a per-file copy: `scp -r` of a Vite
// build is hundreds of round-trips, and `rsync` is not something a Windows checkout can
// count on having. `tar` and `ssh` both ship with Windows 10+ and Git Bash.
const staging = mkdtempSync(join(tmpdir(), "adventures-preview-"));
const tarball = join(staging, "release.tar.gz");
try {
  execFileSync("tar", ["-czf", tarball, "-C", join(repoRoot, "dist"), "."], {
    stdio: "inherit",
  });

  console.log(`Uploading to ${sshHost}:${remoteRoot}`);
  // Two `ssh` calls rather than one, because they need different stdin: the upload feeds
  // the tarball in, and the swap script has to arrive some other way. Both go through
  // `spawnSync` with an explicit fd instead of a shell redirect -- there is no `/bin/sh`
  // on the Windows box this normally runs from, but `ssh` and `tar` are both there.
  const releaseDir = `${remoteRoot}/releases/${releaseId}`;
  const tarballFd = openSync(tarball, "r");
  try {
    run(
      "ssh",
      [
        sshHost,
        `set -eu; umask 022; mkdir -p ${releaseDir}; tar -xzf - -C ${releaseDir}`,
      ],
      [tarballFd, "inherit", "inherit"],
    );
  } finally {
    closeSync(tarballFd);
  }

  // Base64 so the multi-line script survives ssh's remote shell re-parsing it without any
  // quoting games. Separate from the upload above deliberately: nothing here runs unless
  // the extract exited 0, so a truncated transfer cannot reach the symlink swap and
  // publish a half-written release.
  const swapScript = `
set -eu
# Relative target, so the symlink still resolves inside the container's bind mount.
ln -sfn releases/${releaseId} ${remoteRoot}/current.tmp
# -T stops this from meaning "move into the existing symlink's directory"; the rename
# itself is what makes the swap atomic for anyone mid-request.
mv -Tf ${remoteRoot}/current.tmp ${remoteRoot}/current
cd ${remoteRoot}/releases
ls -1dt */ | tail -n +$((${keepReleases} + 1)) | xargs -r rm -rf
echo "serving ${releaseId}"
`;
  const encoded = Buffer.from(swapScript, "utf8").toString("base64");
  run(
    "ssh",
    [sshHost, `echo ${encoded} | base64 -d | sh`],
    ["ignore", "inherit", "inherit"],
  );
} finally {
  rmSync(staging, { recursive: true, force: true });
}

console.log(
  `Preview updated. Open tabs reload within ~3s (vite.config.ts's preview-reload).`,
);
