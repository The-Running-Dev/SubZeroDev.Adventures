/**
 * Regenerates public/campaigns/ from the published content feed.
 *
 * It used to run the engine submodule's own exporter. That exporter is gone: the engine
 * retired its play surface and then removed the published campaign builders from the package
 * root entirely (`engine/src/engine/src/index.ts`: "Adventures.Content owns the source and
 * publication of published campaigns"), so there is nothing left in the submodule to export
 * from. The campaigns now live where that sentence says they do, and this script reads them
 * from there -- the same `SubZeroDev.Adventures.Content` feed the deployed server's only
 * content source points at (`server/src/deployment.ts`).
 *
 * `public/campaigns/` is not a runtime content source in this repo. It is a fixture set
 * several tests import directly (`browser-client.test.ts`, `PlayApp.test.tsx`, the visual
 * baselines) and the snapshot a deployment boots from when the first build off the published
 * source fails (CLAUDE.md, "Campaign Content"). Nothing forces it to stay in step, so run
 * this when a test actually needs the refresh, then diff the result and update the visual
 * baselines if rendered output changed (CLAUDE.md, "Visual Baselines").
 *
 * `getting-started.json` is the one exception: the `/start` wizard's ready-made sample
 * campaign (efb9ec1), hand-authored here rather than published. The feed does publish a
 * campaign under that id, and its bytes are not these -- so the local file survives this
 * script and the manifest is patched to describe what is actually on disk.
 * `browser-client.test.ts` and `PlayApp.test.tsx` import it directly, and `composition.ts`'s
 * `?campaign=getting-started` path resolves it through this same `manifest.json`, so it is
 * read before the wholesale `rm` below and written back afterward. Its side quest is not
 * hand-authored: the feed publishes it as a module campaign plus a manifest attachment
 * (engine S141), and both arrive with the rest of the feed. The two share node ids, so the
 * feed's attachment reaches the local host too.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// `digestManifestResolution` is a package-root export since engine 0.15.0 (S141): a host
// verifying a manifest that carries attachments needs the same recipe the publisher used.
import {
  digestManifestResolution,
  digestPortableCampaign,
} from "@the-running-dev/game-engine";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const targetCampaigns = join(repoRoot, "public", "campaigns");

// The same feed `createPublishedCampaignSource` (server/src/deployment.ts) reads. Restated
// rather than imported: `server/` is a separate npm project with its own dependency tree, and
// this script runs out of the root one.
const FEED = "https://the-running-dev.github.io/SubZeroDev.Adventures.Content/";

const HAND_AUTHORED_CAMPAIGN = "getting-started.json";
const HAND_AUTHORED_FILES = [HAND_AUTHORED_CAMPAIGN];

async function fetchText(file) {
  const response = await fetch(new URL(file, FEED));
  if (!response.ok) {
    throw new Error(`GET ${file} from the content feed: ${response.status}`);
  }
  return response.text();
}

const handAuthored = new Map();
for (const file of HAND_AUTHORED_FILES) {
  try {
    handAuthored.set(file, await readFile(join(targetCampaigns, file)));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // Loud, because the sync still "succeeds" without it. Between the `rm` and the
    // write-back below these files exist only in memory, so a run interrupted in that window
    // leaves them off disk -- and the next run would then quietly publish the feed's own
    // `getting-started`, whose bytes are not the ones the wizard and its tests expect.
    // Recover with `git checkout -- public/campaigns/` before re-running.
    console.warn(
      `Warning: ${file} is missing from public/campaigns/ — it will not be restored or listed in manifest.json.`,
    );
  }
}

console.log(`Fetching the published manifest from ${FEED}...`);
const manifestText = await fetchText("manifest.json");
const manifest = JSON.parse(manifestText);
if (manifest.formatVersion !== 2) {
  throw new Error(
    `Unexpected portable formatVersion ${manifest.formatVersion} — this script writes v2 fixtures.`,
  );
}

// Verified rather than trusted, exactly as `server/src/campaigns/source.ts` and
// `src/play/composition.ts` verify a fetched campaign before using it: a fixture set that
// silently disagrees with its own manifest is one every consumer of it then fails on, far
// from here. This first check covers the manifest's own self-consistency -- a mismatch means
// the feed published one, not that this script computed one wrong.
const publishedResolution = digestManifestResolution(
  manifest.campaigns,
  manifest.attachments,
);
if (
  manifest.resolution !== undefined &&
  manifest.resolution !== publishedResolution
) {
  throw new Error(
    `Published manifest.resolution ${manifest.resolution} does not match its own campaign and attachment lists (${publishedResolution}).`,
  );
}

console.log(`Fetching ${manifest.campaigns.length} published campaign(s)...`);
const fetched = new Map([["manifest.json", manifestText]]);
for (const entry of manifest.campaigns) {
  const text = await fetchText(entry.file);
  const digest = digestPortableCampaign(JSON.parse(text));
  if (digest !== entry.digest) {
    throw new Error(
      `${entry.file} does not match its manifest digest (${digest} vs ${entry.digest}).`,
    );
  }
  fetched.set(entry.file, text);
}

console.log(`Writing ${targetCampaigns}...`);
await rm(targetCampaigns, { recursive: true, force: true });
await mkdir(targetCampaigns, { recursive: true });
for (const [file, text] of fetched) {
  await writeFile(join(targetCampaigns, file), text);
}

for (const [file, contents] of handAuthored) {
  await writeFile(join(targetCampaigns, file), contents);
}

const restoredCampaign = handAuthored.get(HAND_AUTHORED_CAMPAIGN);
if (restoredCampaign) {
  const manifestPath = join(targetCampaigns, "manifest.json");

  let campaigns = manifest.campaigns;
  {
    const portable = JSON.parse(restoredCampaign.toString("utf8"));
    const entry = {
      file: HAND_AUTHORED_CAMPAIGN,
      id: portable.campaign.id,
      version: portable.campaign.version,
      digest: digestPortableCampaign(portable),
    };
    // Replaced where the feed already publishes this file or id, rather than appended
    // unconditionally: the write-back above overwrites the fetched bytes, so a second entry
    // would carry a digest nothing on disk can match. `loadPortableContent`
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

  const overrides = {
    campaigns,
    // Recomputed rather than carried over. `resolution` is a digest over the ordered
    // `{id, version}` list and the attachments (`PortableManifest`'s own doc comment), so
    // splicing a campaign in invalidates the published value -- and a replacement that
    // happens to land on the same id and version leaves it unchanged only by coincidence,
    // not by contract.
    ...(manifest.resolution !== undefined
      ? {
          resolution: digestManifestResolution(campaigns, manifest.attachments),
        }
      : {}),
  };
  // Rebuilt in the published manifest's own key order rather than mutated in place.
  // Iterating the parsed keys rather than naming the ones this script knows about carries
  // through any field a future manifest adds, instead of stripping it on every sync.
  const patched = {};
  for (const key of Object.keys(manifest)) {
    patched[key] = key in overrides ? overrides[key] : manifest[key];
  }

  // Matches the published formatting (2-space, LF, trailing newline) directly. Handing the
  // file to prettier afterwards would be theatre: `public/campaigns/` is listed in
  // `.prettierignore`, so `prettier --write` on this path exits 0 having changed nothing.
  await writeFile(manifestPath, JSON.stringify(patched, null, 2) + "\n");

  console.log(`Re-added ${HAND_AUTHORED_CAMPAIGN} to manifest.json...`);
}

const files = await readdir(targetCampaigns);
console.log(`Synced ${files.length} file(s) into public/campaigns/.`);
