/**
 * Where `createServerDemo` (composition.ts) gets its campaign content from. Disk is the
 * default, not the only option -- the same shape as `identity/provider.ts`: an interface
 * everything outside this file depends on, with exactly one implementation here reading a
 * real filesystem, so composition.ts can be handed a different source (an in-memory one in
 * a test, or one backed by something other than a local disk) without composition.ts
 * itself changing (issue #12). `multi-source.ts` is the other implementation, fanning out
 * to several of these.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import {
  type PortableExtension,
  type PortableManifestWithExtensions,
} from "../../../shared/campaign-extension.js";

export interface LoadedContent {
  readonly campaigns: readonly PortableCampaign[];
  readonly extensions: readonly PortableExtension[];
}

export interface CampaignSource {
  /** One combined fetch for campaigns and extensions -- not two separate methods, so a
   *  source fanning out to several origins (`multi-source.ts`) never fetches the same
   *  manifest twice for one refresh. */
  load(): Promise<LoadedContent>;
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
      const manifest =
        await readJson<PortableManifestWithExtensions>("manifest.json");
      const [campaigns, extensions] = await Promise.all([
        Promise.all(
          manifest.campaigns.map((fileName) =>
            readJson<PortableCampaign>(fileName),
          ),
        ),
        Promise.all(
          (manifest.extensions ?? []).map((fileName) =>
            readJson<PortableExtension>(fileName),
          ),
        ),
      ]);
      return { campaigns, extensions };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Content published without a redeploy, fetched over HTTP -- the delivery half of issue
 * #27. Same interface as `createDiskCampaignSource`, so `composition.ts` and every route
 * downstream of it never learn which one they got.
 *
 * A **partial fetch throws.** One file 404ing (or timing out past its retries) must never
 * silently produce a smaller, perfectly-valid catalog -- that's #22's third failure mode,
 * the one validation cannot catch on its own, because a shorter catalog is not invalid, it
 * is merely wrong. `Promise.all` over every file's fetch gives that for free: any one
 * rejection fails the whole `load()`, and `ContentCell.refresh()` (content-cell.ts) is what
 * turns that into "the previous catalog keeps serving" rather than a partial swap.
 */
export function createHttpCampaignSource(
  baseUrl: string,
  options: { readonly timeoutMs?: number; readonly retries?: number } = {},
): CampaignSource {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;

  async function fetchOnce(path: string): Promise<Response> {
    const response = await fetch(new URL(path, base), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`fetching ${path} returned ${response.status}`);
    return response;
  }

  async function fetchWithRetry(path: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchOnce(path);
      } catch (error) {
        lastError = error;
        if (attempt < retries) await sleep(200 * 2 ** attempt);
      }
    }
    throw new Error(
      `failed to fetch ${path} after ${retries + 1} attempt(s): ${String(lastError)}`,
    );
  }

  async function readJson<T>(path: string): Promise<T> {
    const response = await fetchWithRetry(path);
    return (await response.json()) as T;
  }

  return {
    async load() {
      const manifest =
        await readJson<PortableManifestWithExtensions>("manifest.json");
      const [campaigns, extensions] = await Promise.all([
        Promise.all(
          manifest.campaigns.map((fileName) =>
            readJson<PortableCampaign>(fileName),
          ),
        ),
        Promise.all(
          (manifest.extensions ?? []).map((fileName) =>
            readJson<PortableExtension>(fileName),
          ),
        ),
      ]);
      return { campaigns, extensions };
    },
  };
}
