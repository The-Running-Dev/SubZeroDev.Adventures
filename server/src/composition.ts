/**
 * Server-side composition root — the same shape as `src/play/composition.ts`'s
 * `createBrowserDemo`, but reading campaign JSON off disk instead of over `fetch`, and
 * handed a Postgres-backed `SessionPersistence` instead of `localPersistence()`.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  createEngine,
  createInMemorySessionStore,
  defaultRecordIdSource,
  type Engine,
  type RecordIdSource,
  type SessionStore,
} from "@the-running-dev/game-engine";
import {
  buildCatalog,
  KINDS,
  type CatalogEntry,
} from "../../shared/campaign-registry.js";
import { createPostgresPersistence } from "./persistence.js";
import { createPostgresProfileStore } from "./profile-store.js";
import {
  createDiskCampaignSource,
  type CampaignSource,
} from "./campaigns/source.js";

export interface ServerDemo {
  readonly all: readonly CatalogEntry[];
  /** `all`, hidden campaigns filtered out -- the listing surface, matching
   *  `BrowserDemo.catalog`'s convention (src/play/composition.ts). Read by
   *  badges.ts/routes/profile.ts as the "cataloged" denominator for badges and public
   *  profile stats, so it agrees with what a player actually sees on the shelf. */
  readonly catalog: readonly CatalogEntry[];
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
  /**
   * The same `RecordIdSource` `store` is built with -- exposed so `routes/replay.ts`'s
   * `branch` can mint its new session id through the engine's own identifier source
   * rather than calling `randomUUID()` on the side (issue #11). Branch still writes to
   * `persistence.sessions.put` directly instead of through `SessionStore`, since there is
   * no store operation for it yet; this only closes the id-minting half.
   */
  readonly recordIds: RecordIdSource;
  /**
   * A digest over exactly the content `campaignSource.load()` returned, for the admin page
   * (`routes/admin.ts`) and `/healthz` to show *what* is currently serving without dumping
   * the whole catalog -- two refreshes against unchanged content produce the same digest,
   * so a no-op pull is visibly a no-op rather than looking like a fresh publish.
   */
  readonly contentDigest: string;
}

function digestOf(portables: readonly unknown[]): string {
  // Portable order is manifest order (`Promise.all` preserves input order regardless of
  // resolution order), so this is stable across two loads of the same content -- it is not
  // trying to be stable across a *reordering* of an unchanged manifest, which would be a
  // different content publish anyway.
  return createHash("sha256").update(JSON.stringify(portables)).digest("hex");
}

export async function createServerDemo(
  pool: Pool,
  campaignSource: CampaignSource = createDiskCampaignSource(),
): Promise<ServerDemo> {
  const [portables, extensions] = await Promise.all([
    campaignSource.load(),
    campaignSource.loadExtensions(),
  ]);
  const { registry, all } = buildCatalog(portables, extensions);
  const engine = createEngine({ kinds: KINDS, registry });
  const recordIds = defaultRecordIdSource;

  return {
    all,
    contentDigest: digestOf([portables, extensions]),
    catalog: all.filter((campaign) => !campaign.hidden),
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
    recordIds,
    store: createInMemorySessionStore({
      engine,
      registry,
      persistence: createPostgresPersistence(pool, KINDS),
      profiles: createPostgresProfileStore(pool),
      recordIds,
    }),
  };
}
