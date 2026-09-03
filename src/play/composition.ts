import {
  createEngine,
  createInMemorySessionStore,
  digestPortableCampaign,
  type CampaignSummary,
  type PortableCampaign,
  type SessionPersistence,
  type StoredSaveRecord,
  type SessionStore,
} from "@the-running-dev/game-engine";
import {
  buildCatalog,
  KINDS,
  type CatalogEntry,
  type StatBounds,
} from "../../shared/campaign-registry";
import {
  type PortableExtension,
  type PortableManifestWithExtensions,
} from "../../shared/campaign-extension";
import { createRemoteSessionStore, fetchSaveIndex } from "./remote-store";

export type { StatBounds };
/** Alias retained so nothing downstream of the browser composition needs to change name. */
export type BrowserCampaign = CatalogEntry;

// The `SaveRecordStore` contract keys every operation by `saveId` (types.ts): `get`/`put`/
// `delete` must agree with each other, or a save written under one key is simply never
// found again by `loadGame`. A campaign->saveId index lives alongside it, under the same
// key prefix, so the UI can offer "resume" without the store contract growing a query it
// doesn't otherwise need.
function saveKey(saveId: string): string {
  return `subzerodev.play.save.v1.${saveId}`;
}

function campaignSaveIndexKey(campaignId: string): string {
  return `subzerodev.play.save.v1.index.${campaignId}`;
}

function localPersistence(): SessionPersistence {
  const sessions = new Map();
  return {
    sessions: {
      async get(id) {
        return sessions.get(id);
      },
      async put(record) {
        sessions.set(record.sessionId, record);
      },
    },
    saves: {
      async get(id) {
        const raw = localStorage.getItem(saveKey(id));
        return raw ? (JSON.parse(raw) as StoredSaveRecord) : undefined;
      },
      async put(record) {
        const supersededId = localStorage.getItem(
          campaignSaveIndexKey(record.campaignId),
        );
        localStorage.setItem(saveKey(record.saveId), JSON.stringify(record));
        localStorage.setItem(
          campaignSaveIndexKey(record.campaignId),
          record.saveId,
        );
        // Every autosave mints a fresh saveId (types.ts), so the previous full
        // record would otherwise sit in localStorage unreachable from the index.
        // Removed only after the new record and index are safely written, so a
        // failure here can never erase the only usable checkpoint.
        if (supersededId && supersededId !== record.saveId)
          localStorage.removeItem(saveKey(supersededId));
      },
      async delete(id) {
        const raw = await this.get(id);
        localStorage.removeItem(saveKey(id));
        if (
          raw &&
          localStorage.getItem(campaignSaveIndexKey(raw.campaignId)) === id
        )
          localStorage.removeItem(campaignSaveIndexKey(raw.campaignId));
      },
      // Local mode has no profile concept -- every record here is unprofiled (`put` is
      // always called with whatever `createLocalBrowserDemo`'s anonymous sessions produce,
      // and `createSession` never sets one below) -- so this satisfies `SaveRecordStore`
      // without ever matching anything. `findLocalSave`'s per-campaign index above remains
      // the resume query this composition actually uses locally.
      async listByProfile() {
        return [];
      },
    },
  };
}

function browserStorageAvailable(): boolean {
  try {
    const probe = "subzerodev.play.storage-probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** The saveId of the most recent local save for a campaign, if any -- the resume affordance
 *  the `SaveRecordStore` contract has no query for, since it is keyed by saveId alone. Guarded
 *  the same way `browserStorageAvailable` is: storage can be absent or throw (private
 *  browsing, disabled cookies), and this is called unconditionally from render. */
export function findLocalSave(campaignId: string): string | undefined {
  if (!browserStorageAvailable()) return undefined;
  try {
    return localStorage.getItem(campaignSaveIndexKey(campaignId)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A hidden campaign (`catalog.hidden`, `shared/campaign-registry.ts`) that doubles as the
 * landing experience: `PlayApp.tsx` auto-starts it in place of the disk shelf on a visitor's
 * first-ever load, the same way a `?campaign=` link auto-starts any other hidden campaign.
 * Its own "Skip" control (and simply playing it through) both mark it seen.
 */
export const GETTING_STARTED_CAMPAIGN_ID = "getting-started";

const ONBOARDING_SEEN_KEY = "subzerodev.play.onboarding-seen.v1";

/** Whether the landing wizard has already run (or been skipped) in this browser. Storage
 *  being unavailable is treated as "seen" -- there is nowhere to remember "skipped" in that
 *  environment, and re-showing it on every load would be worse than never showing it. */
export function hasSeenOnboarding(): boolean {
  if (!browserStorageAvailable()) return true;
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markOnboardingSeen(): void {
  if (!browserStorageAvailable()) return;
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // Nothing to fall back to -- the wizard may simply run again next load.
  }
}

// SPIKE: campaigns are runtime-loaded JSON under /campaigns/, not compiled into the
// engine package. See plans/spike-notes.md. `base` matches Vite's `BASE_URL` so this
// resolves under a subpath deploy (`/play/`) the same way the rest of the site does.
async function fetchJson<T>(path: string): Promise<T> {
  const base = import.meta.env.BASE_URL;
  const response = await fetch(`${base}campaigns/${path}`);
  if (!response.ok)
    throw new Error(`Failed to load ${path}: ${response.status}`);
  return (await response.json()) as T;
}

async function loadPortableCampaigns(): Promise<readonly PortableCampaign[]> {
  const manifest =
    await fetchJson<PortableManifestWithExtensions>("manifest.json");
  return Promise.all(
    manifest.campaigns.map(async (entry) => {
      const portable = await fetchJson<PortableCampaign>(entry.file);
      const digest = digestPortableCampaign(portable);
      if (digest !== entry.digest)
        throw new Error(
          `${entry.file}: fetched content does not match manifest digest (expected ${entry.digest}, got ${digest})`,
        );
      return portable;
    }),
  );
}

// Local mode is never the deployed configuration (CLAUDE.md, "Why the merge has to happen
// at content level" -- `deploy.yml` always sets `VITE_API_URL`), but the unit test suite
// forces it (`vite.config.ts`), so it still has to exercise extension merging honestly
// rather than silently skip it.
async function loadPortableExtensions(): Promise<readonly PortableExtension[]> {
  const manifest =
    await fetchJson<PortableManifestWithExtensions>("manifest.json");
  return Promise.all(
    (manifest.extensions ?? []).map((fileName) =>
      fetchJson<PortableExtension>(fileName),
    ),
  );
}

export interface BrowserDemo {
  readonly catalog: readonly BrowserCampaign[];
  /** Resolves any registered campaign, listed or hidden — the direct-link path for a hidden one. */
  findCampaign(campaignId: string): BrowserCampaign | undefined;
  /** The saveId of the most recent local save for a campaign, if any. */
  findLocalSave(campaignId: string): string | undefined;
  readonly store: SessionStore;
  /** Set only in remote mode -- gates the account chip and progress panel (PlayApp.tsx),
   *  which have nothing to talk to against `createLocalBrowserDemo`'s in-browser store. */
  readonly apiUrl?: string;
}

async function createLocalBrowserDemo(): Promise<BrowserDemo> {
  const [portables, extensions] = await Promise.all([
    loadPortableCampaigns(),
    loadPortableExtensions(),
  ]);
  const { registry, all } = buildCatalog(portables, extensions);

  return {
    catalog: Object.freeze(all.filter((campaign) => !campaign.hidden)),
    findCampaign: (campaignId) =>
      all.find((campaign) => campaign.campaignId === campaignId),
    findLocalSave,
    store: createInMemorySessionStore({
      engine: createEngine({ kinds: KINDS, registry }),
      registry,
      persistence:
        typeof localStorage === "undefined" || !browserStorageAvailable()
          ? undefined
          : localPersistence(),
    }),
  };
}

interface CampaignsResponse {
  campaigns: readonly CatalogEntry[];
  summaries: readonly CampaignSummary[];
}

/**
 * `BrowserDemo.findLocalSave()` is synchronous (`PlayApp.tsx` calls it during render) and
 * cannot become a network call, so the save index is resolved up front here rather than
 * queried lazily through `SessionStore.listSaves()`: `/api/campaigns` carries the catalog
 * projection *and* the raw `CampaignSummary[]` `createRemoteSessionStore` wraps as its own
 * (now-async) `listCampaigns()`, and `/api/saves` seeds the save index. The index is a
 * `let`, refreshed after every `saveGame` -- the one piece of remote state this composition
 * owns rather than delegating to `remote-store.ts`.
 */
/** `/api/saves` now serves the engine's own `listSaves` -- every save a profile has, sorted
 *  `savedAt` descending -- rather than a server-side query pre-collapsed to one row per
 *  campaign. This composition still only wants the resume affordance's "most recent save
 *  per campaign", so it collapses client-side: the first entry seen per `campaignId` wins,
 *  which is the most recent given the store's own sort order. */
function latestSaveIdByCampaign(
  saves: readonly { campaignId: string; saveId: string }[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const save of saves) {
    if (!index.has(save.campaignId)) index.set(save.campaignId, save.saveId);
  }
  return index;
}

async function createRemoteBrowserDemo(apiUrl: string): Promise<BrowserDemo> {
  const response = await fetch(`${apiUrl}/api/campaigns`, {
    credentials: "include",
  });
  if (!response.ok)
    throw new Error(`Failed to load the playable catalog: ${response.status}`);
  const { campaigns: all, summaries } =
    (await response.json()) as CampaignsResponse;

  let saveIndex = latestSaveIdByCampaign(await fetchSaveIndex(apiUrl));

  const remoteStore = createRemoteSessionStore(apiUrl, summaries);
  const store: SessionStore = {
    ...remoteStore,
    saveGame: async (sessionId) => {
      const handle = await remoteStore.saveGame(sessionId);
      saveIndex = latestSaveIdByCampaign(await fetchSaveIndex(apiUrl));
      return handle;
    },
  };

  return {
    catalog: Object.freeze(all.filter((campaign) => !campaign.hidden)),
    findCampaign: (campaignId) =>
      all.find((campaign) => campaign.campaignId === campaignId),
    findLocalSave: (campaignId) => saveIndex.get(campaignId),
    store,
    apiUrl,
  };
}

export async function createBrowserDemo(): Promise<BrowserDemo> {
  const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
  return apiUrl ? createRemoteBrowserDemo(apiUrl) : createLocalBrowserDemo();
}
