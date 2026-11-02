import { bundleFor } from "../../shared/offline/runtime.js";
/**
 * Server-side composition root — the same shape as `src/play/composition.ts`'s
 * `createBrowserDemo`, but reading campaign JSON off disk instead of over `fetch`, and
 * handed a Postgres-backed `SessionPersistence` instead of `localPersistence()`.
 */
import type { Pool } from "pg";
import {
  canonicalDigest,
  createEngine,
  createSessionLayer,
  defaultRecordIdSource,
  type Campaign,
  type CampaignProvenance as AuthoredProvenance,
  type ContentRegistry,
  type Engine,
  type SessionHost,
  type SessionLayer,
} from "@the-running-dev/game-engine";
import {
  catalogEntryOf,
  KINDS,
  type CatalogEntry,
} from "../../shared/campaign-registry.js";
import {
  createPostgresPersistence,
  type SessionPersistenceCounters,
} from "./persistence.js";
import { createPostgresProfileStore } from "./profile-store.js";
import {
  createDiskCampaignSource,
  type CampaignSource,
} from "./campaigns/source.js";
import { loadSubmissionCandidates } from "./campaigns/submissions.js";
import { recordQuarantine, recordSourceOutcome } from "./content-sources.js";
import { buildCandidate } from "./content/candidate.js";
import { admittingChannel, epochLockKey } from "./content/admission.js";
import {
  epochKey,
  loadEpochCatalog,
  loadEpochDigests,
} from "./content/epoch-store.js";
import {
  accessibleIn,
  contentRuntimeFor,
  portableOf,
  type ContentRuntime,
  type ContentView,
  type ViewEntry,
  SourceDeletedError,
} from "./content/runtime.js";

/** Where a submission-tier campaign came from and who may currently reach it. Absent from
 *  `ServerDemo.provenance` means core content -- always public, owned by nobody. */
export interface CampaignProvenance {
  readonly ownerPlayerId: string;
  readonly visibility: "private" | "public";
}

export interface ServerDemo {
  /** The process's content: what is current, what is held, and the request gate. Shared by
   *  every `ServerDemo` built over the same pool. */
  readonly runtime: ContentRuntime;
  /** This publication's bundle per campaign -- what the catalog's `offline` flag reads. */
  readonly offlineBundles: ReadonlyMap<
    string,
    import("../../shared/offline/protocol.js").Bundle
  >;
  /** The bundle of one held epoch, current or not: a checkpoint download is served from the
   *  session's own epoch (D4 §3). Undefined when the epoch is not held or has no bundle. */
  bundleForEpoch(
    campaignId: string,
    campaignVersion: string,
  ): Promise<import("../../shared/offline/protocol.js").Bundle | undefined>;
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
   *  `playerId: null` is an anonymous or logged-out request -- core and public only. Read
   *  from the runtime's current publication, not this one's: a cell not yet refreshed still
   *  answers what is current. */
  accessibleCampaignIds(playerId: string | null): ReadonlySet<string>;
  findCampaign(campaignId: string): CatalogEntry | undefined;
  /** The session layer: a `SessionStore` plus `captureSession` (engine spec 08), which only
   *  `captures/store.ts` calls. */
  readonly store: SessionLayer;
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
  /** Every extension actually applied, core and accepted submissions together, grouped by
   *  base campaign in catalog order and in merge order within one -- if an id appears here, `mergeExtensions` (campaign-extension.ts) did
   *  not throw on it, so it landed. Read only by the admin page to show which extensions
   *  applied to which base campaign; nothing gameplay-facing needs it. */
  readonly appliedExtensions: readonly {
    readonly id: string;
    readonly extends: string;
  }[];
}

/** How the session store is bounded and observed. Both fields outlive any one `ServerDemo`:
 *  `app.ts` passes the same values to every build, so a content refresh neither resets the
 *  counters nor changes the limit. */
export interface SessionCacheOptions {
  /** The engine store's `sessionCacheLimit` -- at most this many sessions held in memory,
   *  least recently used evicted first, an evicted one re-read from Postgres on its next
   *  request. Undefined is unbounded, which is what a test wants and what every deployment
   *  had before `SESSION_CACHE_LIMIT`; the deployed process always passes a number
   *  (`deployment.ts`'s `parseSessionCacheLimit`). */
  readonly sessionCacheLimit?: number;
  /** Shared with the admin status route; a fresh set when omitted. */
  readonly counters?: SessionPersistenceCounters;
  /** Called for a session that emitted an `error`-severity event (engine spec 08 §3), after
   *  the faulting command returned and released the session -- `captureSession` takes the
   *  same lock, so it cannot run inside the command. `captures/store.ts`'s `faultCapture`. */
  readonly onSessionFault?: (layer: SessionLayer, sessionId: string) => void;
}

type EmittedRecord = Parameters<
  NonNullable<SessionHost["recordSink"]>["write"]
>[0];

/** The record sink that reports faults. Inert without `onSessionFault`. */
function faultSink(
  onSessionFault: SessionCacheOptions["onSessionFault"],
  layer: () => SessionLayer,
): SessionHost["recordSink"] {
  if (!onSessionFault) return undefined;
  return {
    write(record: EmittedRecord) {
      const { sessionId } = record;
      if (record.event.severity !== "error" || sessionId === undefined) return;
      setImmediate(() => onSessionFault(layer(), sessionId));
    },
  };
}

export async function createServerDemo(
  pool: Pool,
  campaignSource: CampaignSource = createDiskCampaignSource(),
  options: SessionCacheOptions = {},
): Promise<ServerDemo> {
  const runtime = contentRuntimeFor(pool);
  await runtime.ready();
  const { campaigns: trustedPortables, extensions: trustedExtensions } =
    await campaignSource.load();
  // A source deleted between this read and the commit refuses the publication under its lock
  // (D3 §5.2); one rebuild reads the submissions again without it.
  for (let attempt = 0; ; attempt++) {
    try {
      return await publishFrom(
        pool,
        runtime,
        trustedPortables,
        trustedExtensions,
        options,
      );
    } catch (error) {
      if (!(error instanceof SourceDeletedError) || attempt > 0) throw error;
    }
  }
}

async function publishFrom(
  pool: Pool,
  runtime: ContentRuntime,
  trustedPortables: Parameters<typeof buildCandidate>[0],
  trustedExtensions: Parameters<typeof buildCandidate>[1],
  options: SessionCacheOptions,
): Promise<ServerDemo> {
  const { candidates, rowsById } = await loadSubmissionCandidates(pool);
  const held = await loadEpochDigests(pool);
  const candidate = buildCandidate(
    trustedPortables,
    trustedExtensions,
    candidates,
    (sourceId) => {
      const row = rowsById.get(sourceId)!;
      return {
        ownerPlayerId: row.ownerPlayerId!,
        visibility: row.visibility === "public" ? "public" : "private",
      };
    },
    (campaignId, campaignVersion) =>
      held.get(epochKey(campaignId, campaignVersion)),
    runtime.isBlocked,
  );

  // Bookkeeping for the submission tier's own outcome -- a candidate is either quarantined
  // (loaded fine on its own, excluded for colliding with another candidate, or naming a key
  // already held under other content) or, having made it into the publication, recorded the
  // same way a trusted source's successful load is. Quarantines are written before the
  // publication, so a status page never misses a refusal the serving content reflects;
  // acceptances after it, so none is recorded for a publication that was refused.
  await Promise.all(
    candidate.quarantined.map((q) =>
      recordQuarantine(pool, q.sourceId, q.reason),
    ),
  );
  const view = await runtime.publish(candidate);
  await Promise.all(
    candidate.accepted.map((c) =>
      recordSourceOutcome(pool, c.sourceId, {
        ok: true,
        campaignCount: c.portable ? 1 : 0,
        extensionCount: c.extension ? 1 : 0,
      }),
    ),
  );
  return demoFrom(pool, runtime, view, options);
}

/**
 * What is already current, with no source read at all (engine plan 54, §3.3): the boot path
 * once anything has been published, so a restart no longer depends on a source being
 * reachable. Throws when nothing has been published yet -- the first boot needs a source.
 */
export async function createServerDemoFromCurrent(
  pool: Pool,
  options: SessionCacheOptions = {},
): Promise<ServerDemo> {
  const runtime = contentRuntimeFor(pool);
  await runtime.ready();
  const view = runtime.view();
  if (!view) throw new Error("no content publication is current yet");
  return demoFrom(pool, runtime, view, options);
}

function contentDigestOf(entries: readonly ViewEntry[]): string {
  return canonicalDigest(
    entries.map((entry) => [
      entry.campaignId,
      entry.campaignVersion,
      entry.epoch.stored.digest,
      entry.catalog,
      entry.provenance,
    ]),
  );
}

/**
 * One publication, served. Every engine built here shares the process's one archive, so a
 * session or save on an epoch this publication no longer offers still resolves; the
 * construction registry is only this publication's default epoch per campaign.
 */
function demoFrom(
  pool: Pool,
  runtime: ContentRuntime,
  view: ContentView,
  { sessionCacheLimit, counters, onSessionFault }: SessionCacheOptions,
): ServerDemo {
  const { entries } = view;
  const campaigns = new Map<string, Campaign>();
  const strings = new Map<string, string>();
  const authored = new Map<string, AuthoredProvenance>();
  for (const entry of entries) {
    campaigns.set(
      entry.campaignId,
      entry.registry.campaigns.get(entry.campaignId)!,
    );
    for (const [key, value] of entry.registry.strings) strings.set(key, value);
    authored.set(
      entry.campaignId,
      entry.registry.provenance!.get(entry.campaignId)!,
    );
  }
  const registry: ContentRegistry = {
    campaigns,
    strings,
    provenance: authored,
  };

  const all = entries.map((entry) =>
    catalogEntryOf(
      campaigns.get(entry.campaignId)!,
      entry.registry.strings,
      entry.catalog,
    ),
  );
  const isCore = (entry: ViewEntry) => entry.provenance === null;
  const core = all.filter((_, i) => isCore(entries[i]!));

  const provenance = new Map<string, CampaignProvenance>();
  for (const entry of entries)
    if (entry.provenance !== null)
      provenance.set(entry.campaignId, entry.provenance);

  const engine = createEngine({
    kinds: KINDS,
    registry,
    archive: runtime.archive,
  });
  const recordIds = defaultRecordIdSource;
  const recordSink = faultSink(onSessionFault, () => store);
  const store: SessionLayer = createSessionLayer({
    engine,
    registry,
    content: admittingChannel(runtime.channel),
    persistence: createPostgresPersistence(pool, KINDS, counters),
    profiles: createPostgresProfileStore(pool),
    recordIds,
    ...(recordSink === undefined ? {} : { recordSink }),
    ...(sessionCacheLimit === undefined ? {} : { sessionCacheLimit }),
  });

  const offlineBundles = new Map<
    string,
    import("../../shared/offline/protocol.js").Bundle
  >();
  for (const entry of entries) {
    try {
      offlineBundles.set(
        entry.campaignId,
        bundleFor(portableOf(entry.epoch, entry.catalog)),
      );
    } catch {
      /* Unsupported requirements stay online-only. */
    }
  }

  const bundles = new Map<
    string,
    Promise<import("../../shared/offline/protocol.js").Bundle | undefined>
  >();
  async function epochBundle(campaignId: string, campaignVersion: string) {
    const epoch = runtime.epoch(campaignId, campaignVersion);
    if (!epoch) return undefined;
    const catalog = await loadEpochCatalog(pool, campaignId, campaignVersion);
    if (!catalog) return undefined;
    try {
      return bundleFor(portableOf(epoch, catalog));
    } catch {
      return undefined;
    }
  }

  return {
    runtime,
    offlineBundles,
    bundleForEpoch(campaignId, campaignVersion) {
      const key = epochLockKey(campaignId, campaignVersion);
      let bundle = bundles.get(key);
      if (!bundle) {
        bundle = epochBundle(campaignId, campaignVersion);
        bundles.set(key, bundle);
        bundle.catch(() => bundles.delete(key));
      }
      return bundle;
    },
    all,
    core,
    catalog: core.filter((campaign) => !campaign.hidden),
    provenance,
    accessibleCampaignIds: (playerId) =>
      accessibleIn(runtime.view()?.entries ?? entries, playerId),
    contentDigest: contentDigestOf(entries),
    coreContentDigest: contentDigestOf(entries.filter(isCore)),
    appliedExtensions: entries.flatMap((entry) => entry.epoch.extensions),
    findCampaign: (campaignId) =>
      all.find((campaign) => campaign.campaignId === campaignId),
    engine,
    createReplayEngine: (gameId) =>
      createEngine({
        kinds: KINDS,
        registry,
        archive: runtime.archive,
        ids: {
          newGameId: () => gameId,
          newSeed: () => {
            throw new Error(
              "replay engine: newSeed() should never be called -- replay always supplies an explicit seed from the stored state",
            );
          },
        },
      }),
    store,
  };
}
