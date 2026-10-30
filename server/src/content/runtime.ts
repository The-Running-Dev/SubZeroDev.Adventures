/**
 * One process's content (engine plan 54, §3.2-§3.4): a single engine `ContentArchive` holding
 * every epoch this server has published, hydrated from `content_epochs` before anything serves,
 * and the publication that is current. A refresh no longer replaces content -- it adds a
 * publication; what a session or save names stays resolvable for as long as its epoch is held.
 *
 * `ServerDemo` is still rebuilt per publication (an engine and a store over that publication's
 * entries), but every one of them shares this archive, so a session on an epoch the current
 * publication no longer offers still resolves.
 */
import type { Pool } from "pg";
import {
  canonicalDigest,
  createContentArchive,
  ENGINE_VERSION,
  fromPortable,
  type Campaign,
  type ContentArchive,
  type ContentChannel,
  type ContentRegistry,
  type PortableCampaign,
  type RestoreResult,
} from "@the-running-dev/game-engine";
import { KINDS } from "../../../shared/campaign-registry.js";
import { CoreContentError, type Candidate } from "./candidate.js";
import {
  commitPublication,
  epochKey,
  loadCurrent,
  loadEpochs,
  type EntryRow,
  type EpochRow,
} from "./epoch-store.js";

export interface ViewEntry extends EntryRow {
  /** The engine archive's frozen registry for this epoch. */
  readonly registry: ContentRegistry;
  readonly epoch: EpochRow;
}

export interface ContentView {
  readonly publicationId: string;
  readonly stateSeq: number;
  /** In publication order. An entry whose epoch this process cannot restore is left out. */
  readonly entries: readonly ViewEntry[];
  /** The entries left out above: listed as unavailable, never started (D4 §1). */
  readonly withheld: readonly WithheldEntry[];
}

export interface WithheldEntry extends EntryRow {
  readonly epoch: EpochRow;
  readonly result: RestoreResult;
}

export interface ContentRuntime {
  readonly archive: ContentArchive;
  /** Answers a scope the current publication's version of its campaign, only where that
   *  viewer may reach it (§3.4). Never `archive.current`: that is the last publish into this
   *  process, not what is current. */
  readonly channel: ContentChannel;
  /** Hydrates once per process (§3.3). Idempotent. */
  ready(): Promise<void>;
  /** §3.2 steps 2-4. A candidate offering exactly what is current adds no publication. */
  publish(candidate: Candidate): Promise<ContentView>;
  /** The current publication, or undefined before the first one. */
  view(): ContentView | undefined;
  /** Re-hydrates: another process published, or a session names an epoch not yet held. One
   *  catch-up at a time; a caller arriving during one waits for it. */
  catchUp(): Promise<void>;
  /**
   * The request gate (D3 §5.2): may this request serve non-core content? It reads
   * `content_current.state_seq` -- the same as what this process applied continues; higher
   * catches up first; lower means the database went backwards under this process (a restore),
   * which latches the gate closed until a restart; unreadable is closed for this request.
   */
  check(): Promise<boolean>;
  /** A held epoch's stored row, current or not. */
  epoch(campaignId: string, campaignVersion: string): EpochRow | undefined;
  /** Held aside at hydration: the running kind refuses it (§3.3, §3.6). */
  unsupported(
    campaignId: string,
    campaignVersion: string,
  ): RestoreResult | undefined;
}

const EMPTY: ContentRegistry = {
  campaigns: new Map(),
  strings: new Map(),
  provenance: new Map(),
};

/** The `migrateState` an epoch's stored migration spec gives, built by the engine's own
 *  `fromPortable` so it is exactly what a fresh publication would have attached. */
function migrateStateOf(epoch: EpochRow): Campaign["migrateState"] {
  if (epoch.migration === null || epoch.migration === undefined)
    return undefined;
  return fromPortable(portableOf(epoch, undefined as never)).built.campaign
    .migrateState;
}

/** The portable campaign an epoch is, for the offline bundle and for `migrateStateOf`. */
export function portableOf(
  epoch: EpochRow,
  catalog: PortableCampaign["catalog"],
): PortableCampaign {
  const { form } = epoch.stored;
  return {
    formatVersion: 2,
    catalog,
    campaign: {
      ...form.campaign,
      ...(epoch.migration === null || epoch.migration === undefined
        ? {}
        : { migration: epoch.migration }),
    },
    strings: form.strings,
  } as unknown as PortableCampaign;
}

/** What a publication offers, content included: two publications naming the same versions
 *  with different content under one of them are not the same publication. */
function entriesDigest(
  entries: readonly (EntryRow & { readonly digest: string })[],
): string {
  return canonicalDigest(
    entries.map((e) => [
      e.campaignId,
      e.campaignVersion,
      e.digest,
      e.catalog,
      e.provenance,
    ]),
  );
}

/** Core, public, and the viewer's own (`playerId: null` is anonymous). */
export function accessibleIn(
  entries: readonly EntryRow[],
  playerId: string | null,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries)
    if (
      entry.provenance === null ||
      entry.provenance.visibility === "public" ||
      entry.provenance.ownerPlayerId === playerId
    )
      ids.add(entry.campaignId);
  return ids;
}

export function createContentRuntime(pool: Pool): ContentRuntime {
  const archive = createContentArchive({ kinds: KINDS, initial: EMPTY });
  const epochs = new Map<string, EpochRow>();
  const unsupported = new Map<string, RestoreResult>();
  const unsupportedRows = new Map<string, EpochRow>();
  let current: ContentView | undefined;
  let hydrated: Promise<void> | undefined;
  let catching: Promise<void> | undefined;
  // The highest `state_seq` this process has applied. Never moves backwards: a hydration that
  // reads an older head than one already applied leaves `current` as it was.
  let appliedSeq = 0;
  let latched = false;
  // §3.2 step 4: a commit this process could not activate means the database names content the
  // archive does not hold. Nothing after it can be trusted until a restart re-hydrates.
  let activationFailed: string | undefined;

  function viewOf(
    publicationId: string,
    stateSeq: number,
    entries: readonly EntryRow[],
  ): ContentView {
    const out: ViewEntry[] = [];
    const withheld: WithheldEntry[] = [];
    for (const entry of entries) {
      const key = epochKey(entry.campaignId, entry.campaignVersion);
      const registry = archive.resolve(entry.campaignId, entry.campaignVersion);
      const epoch = epochs.get(key);
      if (registry && epoch) {
        out.push({ ...entry, registry, epoch });
        continue;
      }
      const result = unsupported.get(key);
      const row = unsupportedRows.get(key);
      if (result && row) withheld.push({ ...entry, epoch: row, result });
    }
    return { publicationId, stateSeq, entries: out, withheld };
  }

  function apply(view: ContentView): ContentView {
    if (view.stateSeq >= appliedSeq) {
      appliedSeq = view.stateSeq;
      current = view;
    }
    return current!;
  }

  async function hydrate(): Promise<void> {
    for (const row of await loadEpochs(pool)) {
      const { campaign } = row.stored.form;
      const key = epochKey(campaign.id, campaign.version);
      if (epochs.has(key) || unsupported.has(key)) continue;
      const migrateState = migrateStateOf(row);
      const result = archive.restore(
        row.stored,
        migrateState ? { migrateState } : undefined,
      );
      if (result.outcome === "integrity_failure")
        throw new Error(
          `content epoch "${campaign.id}" version "${campaign.version}" failed its integrity check: ${result.errors.map((e) => e.code).join(", ")}`,
        );
      if (result.outcome === "unsupported") {
        unsupported.set(key, result);
        unsupportedRows.set(key, row);
        continue;
      }
      epochs.set(key, row);
    }
    const head = await loadCurrent(pool);
    if (head.publicationId === null)
      appliedSeq = Math.max(appliedSeq, head.stateSeq);
    else apply(viewOf(head.publicationId, head.stateSeq, head.entries));
  }

  function activate(candidate: Candidate): void {
    for (const epoch of candidate.epochs) {
      const published = archive.publish(epoch.registry);
      if (!published.ok) {
        activationFailed = `campaign "${epoch.stored.form.campaign.id}" committed but could not be activated: ${published.errors.map((e) => e.code).join(", ")}`;
        throw new Error(activationFailed);
      }
      const { id, version } = epoch.stored.form.campaign;
      epochs.set(epochKey(id, version), epoch);
    }
  }

  return {
    archive,
    channel: {
      current(scope) {
        const entry = current?.entries.find(
          (e) => e.campaignId === scope.campaignId,
        );
        if (!entry) return undefined;
        return accessibleIn(current!.entries, scope.profileId ?? null).has(
          entry.campaignId,
        )
          ? entry.campaignVersion
          : undefined;
      },
    },
    ready() {
      hydrated ??= hydrate().catch((error: unknown) => {
        hydrated = undefined;
        throw error;
      });
      return hydrated;
    },
    async publish(candidate) {
      await this.ready();
      if (activationFailed) throw new Error(activationFailed);
      // A key is forever (§3.1). Refused here, before the no-op check below, which compares
      // entries rather than content: an epoch edited in place under a held version would pass
      // it and then fail to activate, which would strand this process until a restart.
      for (const epoch of candidate.epochs) {
        const { id, version } = epoch.stored.form.campaign;
        const held = epochs.get(epochKey(id, version));
        if (held && held.stored.digest !== epoch.stored.digest)
          throw new CoreContentError(
            `content_version_conflict: campaign "${id}" version "${version}" is already published with different content`,
          );
      }
      const entries: EntryRow[] = candidate.epochs.map((epoch) => ({
        campaignId: epoch.stored.form.campaign.id,
        campaignVersion: epoch.stored.form.campaign.version,
        catalog: epoch.catalog,
        provenance: epoch.provenance,
      }));
      const offered = entriesDigest(
        entries.map((entry, i) => ({
          ...entry,
          digest: candidate.epochs[i]!.stored.digest,
        })),
      );

      for (let attempt = 0; ; attempt++) {
        const head = await loadCurrent(pool);
        if (
          head.publicationId !== null &&
          entriesDigest(head.entries) === offered
        ) {
          activate(candidate);
          return apply(viewOf(head.publicationId, head.stateSeq, head.entries));
        }
        const result = await commitPublication(pool, {
          parent: head.publicationId,
          reason: "refresh",
          createdBy: "system",
          epochs: candidate.epochs.map((epoch) => ({
            ...epoch,
            engineVersion: ENGINE_VERSION,
          })),
          entries,
        });
        if (result.ok) {
          activate(candidate);
          return apply(viewOf(result.publicationId, result.stateSeq, entries));
        }
        if (result.reason === "stale_parent" && attempt === 0) {
          // Another process published first: take in what it published, then try once more
          // against its publication rather than overwrite it.
          await hydrate();
          continue;
        }
        throw new CoreContentError(
          result.reason === "stale_parent"
            ? "content publication refused: another publication landed twice while this one was being committed"
            : `content_version_conflict: campaign "${result.campaignId}" version "${result.campaignVersion}" was published concurrently with different content`,
        );
      }
    },
    view: () => current,
    epoch: (campaignId, campaignVersion) =>
      epochs.get(epochKey(campaignId, campaignVersion)),
    async catchUp() {
      await this.ready();
      catching ??= hydrate().finally(() => {
        catching = undefined;
      });
      return catching;
    },
    async check() {
      try {
        await this.ready();
      } catch {
        return false;
      }
      if (latched) return false;
      let seq: number;
      try {
        const { rows } = await pool.query<{ state_seq: string }>(
          "select state_seq from content_current",
        );
        seq = Number(rows[0]!.state_seq);
      } catch {
        return false;
      }
      if (seq === appliedSeq) return true;
      if (seq < appliedSeq) {
        latched = true;
        return false;
      }
      try {
        await this.catchUp();
      } catch {
        return false;
      }
      return true;
    },
    unsupported: (campaignId, campaignVersion) =>
      unsupported.get(epochKey(campaignId, campaignVersion)),
  };
}

const runtimes = new WeakMap<Pool, ContentRuntime>();

/** The one runtime per pool -- in a deployment, per process. */
export function contentRuntimeFor(pool: Pool): ContentRuntime {
  let runtime = runtimes.get(pool);
  if (!runtime) {
    runtime = createContentRuntime(pool);
    runtimes.set(pool, runtime);
  }
  return runtime;
}

/** Tests only: drop this pool's runtime, after its epoch tables were truncated. */
export function forgetContentRuntime(pool: Pool): void {
  runtimes.delete(pool);
}
