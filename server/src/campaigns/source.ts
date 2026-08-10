/**
 * Where `createServerDemo` (composition.ts) gets its campaign content from. Disk is the
 * default, not the only option -- the same shape as `identity/provider.ts`: an interface
 * everything outside this file depends on, with exactly one implementation here reading a
 * real filesystem, so composition.ts can be handed a different source (an in-memory one in
 * a test, or one backed by something other than a local disk) without composition.ts
 * itself changing (issue #12).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  PortableCampaign,
  PortableManifest,
} from "@the-running-dev/game-engine";

export interface CampaignSource {
  load(): Promise<readonly PortableCampaign[]>;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The same generated, committed JSON the browser fetches at runtime (CLAUDE.md, "Campaign
 * Content"), read off disk here instead of over HTTP.
 *
 * `dir`'s default is module-relative -- server/src/campaigns/source.ts -> ../../../public/campaigns
 * -- which holds for `npm run start`, for vitest, and for the Dockerfile's `dev` target,
 * since all three run this file from its source location. It does not hold once tsc emits
 * the module somewhere else, so the runtime image sets CAMPAIGNS_DIR to an absolute path
 * rather than arranging its layout to satisfy a relative one that is invisible from the
 * Dockerfile. See server/Dockerfile.
 */
export function createDiskCampaignSource(dir?: string): CampaignSource {
  const campaignsDir =
    dir ??
    process.env.CAMPAIGNS_DIR ??
    join(here, "..", "..", "..", "public", "campaigns");

  async function readJson<T>(fileName: string): Promise<T> {
    const raw = await readFile(join(campaignsDir, fileName), "utf8");
    return JSON.parse(raw) as T;
  }

  return {
    async load() {
      const manifest = await readJson<PortableManifest>("manifest.json");
      return Promise.all(
        manifest.campaigns.map((fileName) =>
          readJson<PortableCampaign>(fileName),
        ),
      );
    },
  };
}
