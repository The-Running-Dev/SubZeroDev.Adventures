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
 * back afterward, with `manifest.json` patched to list them again.
 */

import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { digestPortableCampaign } from "@the-running-dev/game-engine";
// `digestManifestResolution` is deliberately unexported from the engine package's public
// surface (`src/index.ts`'s own comment: author-time-only), and the engine's exporter reaches
// it by a relative import for exactly that reason. This script is the same kind of
// author-time tooling, so it reaches it the same way rather than restating the recipe --
// a second copy of "sha-256 over the canonical ordered {id, version} list" would be free to
// drift from the one `PortableManifest.resolution`'s own contract names. Importing from the
// built submodule adds no precondition the line above does not already impose: the package
// entry point resolves into `dist/` too, so `npm run setup` is required either way.
import { digestManifestResolution } from "../engine/src/engine/dist/portable/digest.js";

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

const HAND_AUTHORED_CAMPAIGN = "getting-started.json";
const HAND_AUTHORED_EXTENSION = "getting-started-extension.json";
const HAND_AUTHORED_FILES = [HAND_AUTHORED_CAMPAIGN, HAND_AUTHORED_EXTENSION];

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
    // Loud, because the sync still "succeeds" without it. Between the `rm` and the
    // write-back below these files exist only in memory, so a run interrupted in that window
    // leaves them off disk -- and the next run would then quietly produce a manifest with no
    // getting-started campaign in it, which is the silent deletion this restore step exists
    // to prevent. Recover with `git checkout -- public/campaigns/` before re-running.
    console.warn(
      `Warning: ${file} is missing from public/campaigns/ — it will not be restored or listed in manifest.json.`,
    );
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

// Gated on the restore having found anything at all, not on the campaign specifically: the
// loop above writes each file back independently, so an extension can reach disk while the
// campaign it belongs to does not, and an extension the manifest does not list is one
// `loadPortableExtensions` (`composition.ts`) silently never loads.
if (handAuthored.size > 0) {
  const manifestPath = join(targetCampaigns, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  let campaigns = manifest.campaigns;
  const restoredCampaign = handAuthored.get(HAND_AUTHORED_CAMPAIGN);
  if (restoredCampaign) {
    const portable = JSON.parse(restoredCampaign.toString("utf8"));
    const entry = {
      file: HAND_AUTHORED_CAMPAIGN,
      id: portable.campaign.id,
      version: portable.campaign.version,
      digest: digestPortableCampaign(portable),
    };
    // Replaced where the engine already exports this file or id, rather than appended
    // unconditionally: the write-back above overwrites the exported bytes, so a second entry
    // would carry a digest nothing on disk can match. `loadPortableCampaigns`
    // (`composition.ts`) throws that mismatch inside a `Promise.all`, taking down the whole
    // catalog load rather than just this one campaign.
    const collision = campaigns.findIndex(
      (candidate) => candidate.file === entry.file || candidate.id === entry.id,
    );
    campaigns =
      collision === -1
        ? [...campaigns, entry]
        : campaigns.with(collision, entry);
  }

  const extensions = handAuthored.has(HAND_AUTHORED_EXTENSION)
    ? [...new Set([...(manifest.extensions ?? []), HAND_AUTHORED_EXTENSION])]
    : manifest.extensions;

  const overrides = {
    campaigns,
    ...(extensions ? { extensions } : {}),
    // Recomputed rather than carried over. `resolution` is a digest over the ordered
    // `{id, version}` list (`PortableManifest`'s own doc comment), so splicing a campaign in
    // invalidates the value the exporter computed for its own export set -- leaving it would
    // publish a 10-campaign manifest under a 9-campaign digest.
    ...(manifest.resolution !== undefined
      ? { resolution: digestManifestResolution(campaigns) }
      : {}),
  };
  // Rebuilt in the parsed manifest's own key order rather than mutated in place -- the
  // engine's export omits `extensions` entirely when it has none, so assigning it would
  // append the key after `resolution` instead of before it. Iterating the parsed keys rather
  // than naming the ones this script knows about also carries through any field a future
  // engine manifest adds, instead of stripping it on every sync.
  const patched = {};
  for (const key of Object.keys(manifest)) {
    if (key === "resolution" && overrides.extensions && !manifest.extensions) {
      patched.extensions = overrides.extensions;
    }
    patched[key] = key in overrides ? overrides[key] : manifest[key];
  }
  if (overrides.extensions && !patched.extensions) {
    patched.extensions = overrides.extensions;
  }

  // Matches the exporter's own formatting (2-space, LF, trailing newline) directly. Handing
  // the file to prettier afterwards would be theatre: `public/campaigns/` is listed in
  // `.prettierignore`, so `prettier --write` on this path exits 0 having changed nothing.
  await writeFile(manifestPath, JSON.stringify(patched, null, 2) + "\n");

  console.log(
    `Re-added ${handAuthored.size} hand-authored file(s) to manifest.json...`,
  );
}

const files = await readdir(targetCampaigns);
console.log(`Synced ${files.length} file(s) into public/campaigns/.`);
