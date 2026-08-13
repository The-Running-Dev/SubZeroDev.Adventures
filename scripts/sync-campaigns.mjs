/**
 * Regenerates public/campaigns/ from the pinned engine submodule.
 *
 * The engine's exporter (engine/src/engine/scripts/export-campaigns.ts, graduated out of
 * spike status) writes to a path hardcoded relative to itself: engine/site/public/campaigns/
 * -- that's the engine repo's *own* site/, which ships inside the submodule alongside the
 * package. Rather than patching that path, this script runs the exporter as-is and copies
 * its output here.
 *
 * `public/campaigns/` is not wired into any runtime path in this repo -- the server's only
 * content source is `SubZeroDev.Adventures.Content` (`server/src/index.ts`), and the
 * standalone browser build always sets `VITE_API_URL` (`deploy.yml`). What's synced here is
 * a fixture set several tests import directly (`browser-client.test.ts`, `PlayApp.test.tsx`,
 * the visual baselines) -- run this after bumping the submodule so those fixtures track the
 * engine's current portable format, then diff the result and update the visual baselines if
 * rendered output actually changed (CLAUDE.md, "Visual Baselines").
 *
 * `getting-started.json` / `getting-started-extension.json` are the one exception: the
 * `/start` wizard's ready-made sample campaign (efb9ec1), hand-authored rather than exported
 * from the engine, and not part of `export-campaigns.ts`'s campaign list at all. They still
 * have to survive this script -- `browser-client.test.ts` and `PlayApp.test.tsx` import them
 * directly, and `composition.ts`'s `?campaign=getting-started` path resolves them through
 * this same `manifest.json` -- so they are read before the wholesale `rm` below and written
 * back afterward, with `manifest.json` patched to list them again. Their own `resolution`
 * contribution is left out of that patch: `digestManifestResolution` recipe is deliberately
 * unexported from the engine package (author-time-only, `src/index.ts`'s own comment), and
 * nothing in this repo reads `manifest.json`'s `resolution` field, so there is nothing to
 * keep correct by reproducing it here.
 */

import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { digestPortableCampaign } from "@the-running-dev/game-engine";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const enginePackagePath = join(repoRoot, "engine", "src", "engine");
const engineExportedCampaigns = join(
  repoRoot,
  "engine",
  "site",
  "public",
  "campaigns",
);
const targetCampaigns = join(repoRoot, "public", "campaigns");

const HAND_AUTHORED_FILES = [
  "getting-started.json",
  "getting-started-extension.json",
];

const npmCli = process.env["npm_execpath"];
if (!npmCli) {
  throw new Error(
    "npm_execpath is unset — run this through `npm run sync:campaigns`, not `node` directly",
  );
}

const handAuthored = new Map();
for (const file of HAND_AUTHORED_FILES) {
  try {
    handAuthored.set(file, await readFile(join(targetCampaigns, file)));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

console.log("Exporting campaigns from the pinned engine submodule...");
execFileSync(process.execPath, [npmCli, "run", "export:campaigns"], {
  cwd: enginePackagePath,
  stdio: "inherit",
});

console.log(`Copying exported campaigns into ${targetCampaigns}...`);
await rm(targetCampaigns, { recursive: true, force: true });
await mkdir(targetCampaigns, { recursive: true });
await cp(engineExportedCampaigns, targetCampaigns, { recursive: true });

for (const [file, contents] of handAuthored) {
  await writeFile(join(targetCampaigns, file), contents);
}

if (handAuthored.has("getting-started.json")) {
  const manifestPath = join(targetCampaigns, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const gettingStarted = JSON.parse(
    handAuthored.get("getting-started.json").toString("utf8"),
  );
  const campaigns = [
    ...manifest.campaigns,
    {
      file: "getting-started.json",
      id: gettingStarted.campaign.id,
      version: gettingStarted.campaign.version,
      digest: digestPortableCampaign(gettingStarted),
    },
  ];
  const extensions = handAuthored.has("getting-started-extension.json")
    ? [...(manifest.extensions ?? []), "getting-started-extension.json"]
    : manifest.extensions;
  // Rebuilt with an explicit key order rather than mutating the parsed object -- the
  // engine's own export omits `extensions` entirely when it has none, so assigning it here
  // would append the key after `resolution` instead of before it.
  const patched = {
    formatVersion: manifest.formatVersion,
    campaigns,
    ...(extensions ? { extensions } : {}),
    ...(manifest.resolution !== undefined
      ? { resolution: manifest.resolution }
      : {}),
  };
  await writeFile(manifestPath, JSON.stringify(patched, null, 2) + "\n");

  console.log(
    "Re-added hand-authored getting-started campaign to manifest.json...",
  );
  execFileSync(
    process.execPath,
    [npmCli, "exec", "--", "prettier", "--write", manifestPath],
    { cwd: repoRoot, stdio: "inherit" },
  );
}

const files = await readdir(targetCampaigns);
console.log(`Synced ${files.length} file(s) into public/campaigns/.`);
