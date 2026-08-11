import {
  createEngine,
  createInMemorySessionStore,
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
    manifest.campaigns.map((fileName) => fetchJson<PortableCampaign>(fileName)),
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
 * `SessionStore.listCampaigns()` and `BrowserDemo.findLocalSave()` are both synchronous
 * (04-core.md; `PlayApp.tsx` calls `findLocalSave` during render) and neither can become a
 * network call, so both are resolved up front here: `/api/campaigns` carries the catalog
 * projection *and* the raw `CampaignSummary[]` the store contract needs, and `/api/saves`
 * seeds the save index. The index is a `let`, refreshed after every `saveGame` -- the one
 * piece of remote state this composition owns rather than delegating to `remote-store.ts`.
 */
async function createRemoteBrowserDemo(apiUrl: string): Promise<BrowserDemo> {
  const response = await fetch(`${apiUrl}/api/campaigns`, {
    credentials: "include",
  });
  if (!response.ok)
    throw new Error(`Failed to load the playable catalog: ${response.status}`);
  const { campaigns: all, summaries } =
    (await response.json()) as CampaignsResponse;

  let saveIndex = new Map(
    (await fetchSaveIndex(apiUrl)).map((save) => [
      save.campaignId,
      save.saveId,
    ]),
  );

  const remoteStore = createRemoteSessionStore(apiUrl, summaries);
  const store: SessionStore = {
    ...remoteStore,
    saveGame: async (sessionId) => {
      const handle = await remoteStore.saveGame(sessionId);
      saveIndex = new Map(
        (await fetchSaveIndex(apiUrl)).map((save) => [
          save.campaignId,
          save.saveId,
        ]),
      );
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
