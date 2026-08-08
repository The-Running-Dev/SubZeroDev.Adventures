/**
 * Regenerates public/campaigns/ from the pinned engine submodule.
 *
 * The engine's exporter (engine/src/engine/scripts/spike-export-campaigns.ts) writes to a
 * path hardcoded relative to itself: engine/site/public/campaigns/ -- that's the engine
 * repo's *own* site/, which ships inside the submodule alongside the package. Rather than
 * patching that path (a cross-repo change to a script explicitly marked a throwaway spike,
 * `plans/spike-notes.md`), this script runs the exporter as-is and copies its output here.
 *
 * Run after bumping the submodule to a new engine commit, then diff the result: a change in
 * public/campaigns/ that wasn't reviewed is a silent content change shipping to players.
 */

import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

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

const npmCli = process.env["npm_execpath"];
if (!npmCli) {
  throw new Error(
    "npm_execpath is unset — run this through `npm run sync:campaigns`, not `node` directly",
  );
}

console.log("Exporting campaigns from the pinned engine submodule...");
execFileSync(process.execPath, [npmCli, "run", "spike:export"], {
  cwd: enginePackagePath,
  stdio: "inherit",
});

console.log(`Copying exported campaigns into ${targetCampaigns}...`);
await rm(targetCampaigns, { recursive: true, force: true });
await mkdir(targetCampaigns, { recursive: true });
await cp(engineExportedCampaigns, targetCampaigns, { recursive: true });

const files = await readdir(targetCampaigns);
console.log(`Synced ${files.length} file(s) into public/campaigns/.`);
