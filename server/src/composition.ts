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
  type SessionStore,
} from "@the-running-dev/game-engine";
import {
  buildTieredCatalog,
  KINDS,
  type CatalogEntry,
} from "../../shared/campaign-registry.js";
import { createPostgresPersistence } from "./persistence.js";
import { createPostgresProfileStore } from "./profile-store.js";
import {
  createDiskCampaignSource,
  type CampaignSource,
} from "./campaigns/source.js";
import { loadSubmissionCandidates } from "./campaigns/submissions.js";
import { recordQuarantine, recordSourceOutcome } from "./content-sources.js";

/** Where a submission-tier campaign came from and who may currently reach it. Absent from
 *  `ServerDemo.provenance` means core content -- always public, owned by nobody. */
export interface CampaignProvenance {
  readonly ownerPlayerId: string;
  readonly visibility: "private" | "public";
}

export interface ServerDemo {
  /** Every registered campaign, core and submission alike, listed and hidden -- access is a
   *  separate question `accessibleCampaignIds` answers, same as `hidden` always has been:
   *  registered but not access-checked is not the same as visible to a given request. */
  readonly all: readonly CatalogEntry[];
  /** Core content only -- the builtin source plus whatever an admin has added, none of it
   *  player-submitted. Used for `catalogSize`-style denominators (badges' `catalogSize`,
   *  `routes/profile.ts`'s public "campaigns played" stat) and the listing surface
   *  (`catalog`, below). Cross-player *fairness* queries (badges' cross-player baselines,
   *  the leaderboard, rarity records) read `provenance`'s keys instead, as a deny-list, not
   *  this as an allow-list -- see `provenance`'s own doc comment for why the two aren't
   *  interchangeable. */
  readonly core: readonly CatalogEntry[];
  /** `core`, hidden campaigns filtered out -- the listing surface, matching
   *  `BrowserDemo.catalog`'s convention (src/play/composition.ts). */
  readonly catalog: readonly CatalogEntry[];
  /**
   * Every submission-tier campaign's ownership and visibility, keyed by campaign id. A
   * campaign with no entry here is core.
   *
   * `platform-baselines.ts`'s cross-player queries (badges' rarity/percentile baselines,
   * the leaderboard, the Rarest Ending record) take this map's *keys* as an exclusion list,
   * not `core` as an inclusion list -- a real session's `campaign_id` is always either core
   * or a submission, so the two would agree for real gameplay, but excluding only known
   * submissions is what stays correct for a `sessions` row whose `campaign_id` isn't
   * currently registered at all (a revoked submission, or a synthetic id a test seeds
   * directly without going through the registry) -- an allow-list would wrongly treat that
   * row as if it belonged to a submission and drop it from the comparison; a deny-list
   * leaves it counted, which is what "not a known submission" actually means.
   */
  readonly provenance: ReadonlyMap<string, CampaignProvenance>;
  /** Every campaign id a given viewer may currently reach: all of `core`, plus their own
   *  submissions regardless of visibility, plus every other player's `public` ones.
   *  `playerId: null` is an anonymous or logged-out request -- core and public only. */
  accessibleCampaignIds(playerId: string | null): ReadonlySet<string>;
  /**
   * The string-table slice a session touching exactly these campaigns may see -- always
   * includes the system/kind-level reason messages every campaign shares (they are not any
   * campaign's own key, so they are never excluded), plus each named campaign's own declared
   * keys. Never the raw `registry.strings` map: that is one flat table with no per-campaign
   * partition, and handing it over whole is how a session in one campaign would otherwise read
   * every other campaign's narrative text, private submissions included.
   */
  stringsFor(campaignIds: Iterable<string>): Record<string, string>;
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
   * A digest over everything currently serving, core and submissions together, for the admin
   * page (`routes/admin.ts`) to show *what* is currently serving without dumping the whole
   * catalog -- two refreshes against unchanged content produce the same digest, so a no-op
   * pull is visibly a no-op rather than looking like a fresh publish. Admin-only: this moves
   * on a change to any private submission, which is exactly why `/healthz` (unauthenticated)
   * reads `coreContentDigest` instead, not this one -- otherwise an anonymous request could
   * poll it as a "did a private submission just change" side channel.
   */
  readonly contentDigest: string;
  /** Core content only -- what `/healthz` reports. See `contentDigest`'s note on why the two
   *  are not the same field. */
  readonly coreContentDigest: string;
  /** Every extension actually applied, core and accepted submissions together, in the order
   *  they were merged -- if an id appears here, `mergeExtensions` (campaign-extension.ts) did
   *  not throw on it, so it landed. Read only by the admin page to show which extensions
   *  applied to which base campaign; nothing gameplay-facing needs it. */
  readonly appliedExtensions: readonly {
    readonly id: string;
    readonly extends: string;
  }[];
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
  const { campaigns: trustedPortables, extensions: trustedExtensions } =
    await campaignSource.load();
  const { candidates, rowsById } = await loadSubmissionCandidates(pool);
  const { registry, all, campaignStringKeys, quarantined, trusted } =
    buildTieredCatalog(trustedPortables, trustedExtensions, candidates);

  // Bookkeeping for the submission tier's own outcome -- a candidate is either quarantined
  // (loaded fine on its own, excluded for colliding with another candidate) or, having made
  // it into `all`, recorded the same way a trusted source's successful load is. Both run
  // before this returns, same posture as `multi-source.ts`'s "persisted before the throw" --
  // there is no throw here (the submission tier is fail-open by construction), but a status
  // page reading stale bookkeeping while a fresh demo is already serving would be its own bug.
  const quarantinedIds = new Set(quarantined.map((q) => q.sourceId));
  const acceptedCandidates = candidates.filter(
    (c) => !quarantinedIds.has(c.sourceId),
  );
  await Promise.all([
    ...quarantined.map((q) => recordQuarantine(pool, q.sourceId, q.reason)),
    ...acceptedCandidates.map((c) =>
      recordSourceOutcome(pool, c.sourceId, {
        ok: true,
        campaignCount: c.portable ? 1 : 0,
        extensionCount: c.extension ? 1 : 0,
      }),
    ),
  ]);

  const provenance = new Map<string, CampaignProvenance>();
  for (const candidate of acceptedCandidates) {
    if (!candidate.portable) continue; // an extension has no campaign id of its own; its
    // base campaign (also a candidate, per the ownership check in submissions.ts) already
    // carries the provenance that governs the merged content's visibility.
    const row = rowsById.get(candidate.sourceId)!;
    provenance.set(candidate.portable.campaign.id, {
      ownerPlayerId: row.ownerPlayerId!,
      visibility: row.visibility === "public" ? "public" : "private",
    });
  }

  const acceptedExtensions = [
    ...trustedExtensions,
    ...acceptedCandidates
      .filter(
        (c): c is typeof c & { extension: NonNullable<typeof c.extension> } =>
          c.extension !== undefined,
      )
      .map((c) => c.extension),
  ];

  // Every campaign's own string keys, unioned, so a system/kind-level reason message (never
  // any campaign's own key) is told apart from campaign-authored narrative text without this
  // file needing to know what those messages actually are.
  const allCampaignStringKeys = new Set<string>();
  for (const keys of campaignStringKeys.values())
    for (const key of keys) allCampaignStringKeys.add(key);

  const engine = createEngine({ kinds: KINDS, registry });
  const recordIds = defaultRecordIdSource;

  return {
    all,
    core: trusted.all,
    catalog: trusted.all.filter((campaign) => !campaign.hidden),
    provenance,
    accessibleCampaignIds(playerId) {
      const ids = new Set(trusted.all.map((campaign) => campaign.campaignId));
      for (const [campaignId, entry] of provenance) {
        if (entry.visibility === "public" || entry.ownerPlayerId === playerId)
          ids.add(campaignId);
      }
      return ids;
    },
    stringsFor(campaignIds) {
      const keys = new Set<string>();
      for (const [key] of registry.strings)
        if (!allCampaignStringKeys.has(key)) keys.add(key);
      for (const campaignId of campaignIds)
        for (const key of campaignStringKeys.get(campaignId) ?? [])
          keys.add(key);

      const out: Record<string, string> = {};
      for (const key of keys) {
        const value = registry.strings.get(key);
        if (value !== undefined) out[key] = value;
      }
      return out;
    },
    contentDigest: digestOf([
      trustedPortables,
      trustedExtensions,
      acceptedCandidates,
    ]),
    coreContentDigest: digestOf([trustedPortables, trustedExtensions]),
    appliedExtensions: acceptedExtensions.map((extension) => ({
      id: extension.id,
      extends: extension.extends,
    })),
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
      persistence: createPostgresPersistence(pool, KINDS),
      profiles: createPostgresProfileStore(pool),
      recordIds,
    }),
  };
}
