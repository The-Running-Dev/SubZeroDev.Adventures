/**
 * Server-side composition root — the same shape as `src/play/composition.ts`'s
 * `createBrowserDemo`, but reading campaign JSON off disk instead of over `fetch`, and
 * handed a Postgres-backed `SessionPersistence` instead of `localPersistence()`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import {
  createEngine,
  createInMemorySessionStore,
  type Engine,
  type PortableCampaign,
  type PortableManifest,
  type SessionStore,
} from "@the-running-dev/game-engine";
import {
  buildCatalog,
  KINDS,
  type CatalogEntry,
} from "../../shared/campaign-registry.js";
import { createPostgresPersistence } from "./persistence.js";
import { createPostgresProfileStore } from "./profile-store.js";

const here = dirname(fileURLToPath(import.meta.url));
// server/src/composition.ts -> ../../public/campaigns -- the same generated, committed
// JSON the browser fetches at runtime (CLAUDE.md, "Campaign Content"), read off disk here
// instead of over HTTP.
const campaignsDir = join(here, "..", "..", "public", "campaigns");

async function readJson<T>(fileName: string): Promise<T> {
  const raw = await readFile(join(campaignsDir, fileName), "utf8");
  return JSON.parse(raw) as T;
}

async function loadPortableCampaigns(): Promise<readonly PortableCampaign[]> {
  const manifest = await readJson<PortableManifest>("manifest.json");
  return Promise.all(
    manifest.campaigns.map((fileName) => readJson<PortableCampaign>(fileName)),
  );
}

export interface ServerDemo {
  readonly all: readonly CatalogEntry[];
  findCampaign(campaignId: string): CatalogEntry | undefined;
  readonly store: SessionStore;
  /** The raw `Engine`, exposed for `replay.ts` -- it drives `deserialize`/`submitAction`/
   *  `scene`/`serialize` directly against a session's stored blob, outside the session
   *  store's own id-keyed surface. Never call `.createGame` on this one for a replay --
   *  its `IdSource` is the default random one, so a fresh `createGame` would mint a new
   *  `gameId` unrelated to the session being replayed. Use `createReplayEngine` for that. */
  readonly engine: Engine;
  /**
   * `defaultIdSource.newGameId` is `crypto.randomUUID()` (06-extensibility.md §5.1) --
   * deliberately unpredictable, and never derived from `seed`. A real session's `gameId`
   * is picked once at `createSession` and never changes again, so reproducing a stored
   * session's exact blob (`replay.ts`'s `verifyReplay`) means replaying its `createGame`
   * call against an `Engine` whose `IdSource` is pinned to return that same `gameId` --
   * not the shared `engine` above, whose default `IdSource` would mint a different one
   * every call.
   */
  createReplayEngine(gameId: string): Engine;
}

export async function createServerDemo(pool: Pool): Promise<ServerDemo> {
  const portables = await loadPortableCampaigns();
  const { registry, all } = buildCatalog(portables);
  const engine = createEngine({ kinds: KINDS, registry });

  return {
    all,
    findCampaign: (campaignId) =>
      all.find((campaign) => campaign.campaignId === campaignId),
    engine,
    createReplayEngine: (gameId) =>
      createEngine({
        kinds: KINDS,
        registry,
        ids: {
          newGameId: () => gameId,
          newSeed: () => {
            throw new Error(
              "replay engine: newSeed() should never be called -- replay always supplies an explicit seed from the stored state",
            );
          },
        },
      }),
    store: createInMemorySessionStore({
      engine,
      registry,
      persistence: createPostgresPersistence(pool),
      profiles: createPostgresProfileStore(pool),
    }),
  };
}
