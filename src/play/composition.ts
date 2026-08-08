import {
  buildValidatedContentRegistry,
  createEngine,
  createInMemorySessionStore,
  fromPortable,
  simulationKind,
  storyGraphKind,
  worldGraphKind,
  type PortableCampaign,
  type PortableManifest,
  type SessionPersistence,
  type StoredSaveRecord,
  type SessionStore,
} from "@the-running-dev/game-engine";

/** The declared clamp range of one visible int stat, for rendering it as a meter rather than a bare number. */
export interface StatBounds {
  readonly min?: number;
  readonly max?: number;
}

export interface BrowserCampaign {
  readonly campaignId: string;
  readonly title: string;
  readonly description: string;
  readonly duration: string;
  readonly contentNotice: string;
  readonly featured: boolean;
  /** Playable and registered, but omitted from the public dossier grid — reachable only by a direct `?campaign=` link. */
  readonly hidden?: boolean;
  readonly sources?: readonly { label: string; href: string }[];
  /**
   * Declared `min`/`max` for each visible int variable, keyed by variable name.
   * Empty for a campaign whose stats are all unbounded, and for any kind that
   * does not declare variables this way.
   */
  readonly statBounds: Readonly<Record<string, StatBounds>>;
}

/**
 * `Campaign.content` is deliberately `unknown` to the core — kind-specific and
 * opaque (registry/types.ts). The player projection carries a stat's *value* but
 * not its declared range (`VisibleStat`, story-graph/view.ts, which omits it to
 * avoid duplicating campaign content in the view), so rendering "3 / 26" instead
 * of a bare "3" means reading the range from the campaign this client already
 * fetched.
 *
 * That makes this a read across the same non-contract boundary `CLAUDE.md` flags
 * for `fromPortable`: a story-graph `VariableSchema` shape assumed structurally,
 * not imported. It is therefore written to degrade rather than throw — a kind
 * with no `variables` (simulation, world-graph), or a variable missing the
 * fields, simply yields no bounds and the stat renders as it does today.
 */
function statBoundsOf(content: unknown): Record<string, StatBounds> {
  const variables = (
    content as {
      variables?: Record<
        string,
        { type?: unknown; visible?: unknown; min?: unknown; max?: unknown }
      >;
    }
  )?.variables;
  if (typeof variables !== "object" || variables === null) return {};

  const bounds: Record<string, StatBounds> = {};
  for (const [name, decl] of Object.entries(variables)) {
    if (decl?.type !== "int" || decl.visible !== true) continue;
    const min = typeof decl.min === "number" ? decl.min : undefined;
    const max = typeof decl.max === "number" ? decl.max : undefined;
    if (min === undefined && max === undefined) continue;
    bounds[name] = {
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    };
  }
  return bounds;
}

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
  const manifest = await fetchJson<PortableManifest>("manifest.json");
  return Promise.all(
    manifest.campaigns.map((fileName) => fetchJson<PortableCampaign>(fileName)),
  );
}

export interface BrowserDemo {
  readonly catalog: readonly BrowserCampaign[];
  /** Resolves any registered campaign, listed or hidden — the direct-link path for a hidden one. */
  findCampaign(campaignId: string): BrowserCampaign | undefined;
  /** The saveId of the most recent local save for a campaign, if any. */
  findLocalSave(campaignId: string): string | undefined;
  readonly store: SessionStore;
}

export async function createBrowserDemo(): Promise<BrowserDemo> {
  const portables = await loadPortableCampaigns();
  const hydrated = portables.map((portable) => fromPortable(portable));

  const kinds = {
    "story-graph": storyGraphKind,
    simulation: simulationKind,
    "world-graph": worldGraphKind,
  } as const;
  const registry = buildValidatedContentRegistry(
    hydrated.map((h) => h.built),
    kinds,
  );
  if (!registry.ok || !registry.value)
    throw new Error(
      `The playable catalog could not be validated: ${JSON.stringify(registry.errors)}`,
    );

  const all = hydrated.map(({ built, catalog }) => ({
    campaignId: built.campaign.id,
    title:
      registry.value!.strings.get(built.campaign.titleKey) ?? catalog.title,
    description: catalog.description,
    duration: catalog.duration,
    contentNotice: catalog.contentNotice,
    featured: catalog.featured,
    ...(catalog.hidden ? { hidden: true } : {}),
    ...(catalog.sources ? { sources: catalog.sources } : {}),
    statBounds: Object.freeze(statBoundsOf(built.campaign.content)),
  }));

  return {
    catalog: Object.freeze(all.filter((campaign) => !campaign.hidden)),
    findCampaign: (campaignId) =>
      all.find((campaign) => campaign.campaignId === campaignId),
    findLocalSave,
    store: createInMemorySessionStore({
      engine: createEngine({ kinds, registry: registry.value }),
      registry: registry.value,
      persistence:
        typeof localStorage === "undefined" || !browserStorageAvailable()
          ? undefined
          : localPersistence(),
    }),
  };
}
