/**
 * Admission (engine plan 54, D4 §2-§3, D3 §5.2): which epoch a write may name, decided once at
 * the route and checked again inside the write's own transaction.
 *
 * - **The gate** runs before the store is called. A new start is refused when its campaign is not
 *   in the current publication (404), not reachable by the caller (403), or held on an epoch this
 *   process cannot run (409). An existing session or save is refused when its campaign was revoked
 *   from the caller (403 `campaign_access_revoked`), when its epoch cannot run here (409), and
 *   when an epoch it names was permanently deleted (410 `campaign_deleted`, D3 §5).
 * - **The admission** rides in `AsyncLocalStorage` from the gate to the write, through the engine
 *   store, which has no parameter for it. `createSession`'s `ContentChannel` offer reads the
 *   admitted version from it, so the session starts on exactly what the gate checked.
 * - **The fence** runs inside the write's transaction: a shared advisory lock per epoch named,
 *   then `content_current` read `for share`, so a publication either commits before the write
 *   checks it, or waits until the write has committed. A write the current publication no longer
 *   admits is refused, and a revision-0 session write or a grant insert with no admission at all
 *   is refused too -- every path that mints one has to pass through a gate to get one.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import type { ContentChannel } from "@the-running-dev/game-engine";
import { epochKeyHash, loadCurrent } from "./epoch-store.js";
import { accessibleIn, type ContentRuntime } from "./runtime.js";

export type Admission =
  /** A session or grant starting from nothing: exactly this version, still current. */
  | {
      readonly kind: "new";
      readonly campaignId: string;
      readonly campaignVersion: string;
      readonly playerId: string | null;
    }
  /** A write derived from an existing session or save: one of its versions, or the current one
   *  (a load adopting the current epoch on the way in). */
  | {
      readonly kind: "derived";
      readonly campaignId: string;
      readonly versions: ReadonlySet<string>;
      readonly playerId: string | null;
    };

const storage = new AsyncLocalStorage<Admission>();

export function runAdmitted<T>(
  admission: Admission,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(admission, fn);
}

export function currentAdmission(): Admission | undefined {
  return storage.getStore();
}

/** A refusal the route answers as-is: `{error: {operation, code}}` with `status`. */
export class ContentRefusal extends Error {
  readonly operation: string;
  readonly code: string;
  readonly status: number;

  constructor(operation: string, code: ContentRefusalCode) {
    super(`content: ${operation} — ${code}`);
    this.name = "ContentRefusal";
    this.operation = operation;
    this.code = code;
    this.status = REFUSAL_STATUS[code];
  }
}

const REFUSAL_STATUS = {
  unknown_campaign: 404,
  forbidden: 403,
  campaign_access_revoked: 403,
  campaign_version_unsupported: 409,
  campaign_version_unavailable: 409,
  concurrent_modification: 409,
  campaign_deleted: 410,
  storage_failure: 503,
} as const;

export type ContentRefusalCode = keyof typeof REFUSAL_STATUS;

/** The advisory-lock key of one epoch. Not `epochKey`: Postgres text cannot hold its NUL. */
export function epochLockKey(
  campaignId: string,
  campaignVersion: string,
): string {
  return JSON.stringify([campaignId, campaignVersion]);
}

export interface Lineage {
  readonly campaignId: string;
  /** The version the blob is on now. */
  readonly campaignVersion: string;
  /** Every version it names, `campaignVersion` included. */
  readonly versions: ReadonlySet<string>;
}

/**
 * Every epoch a stored blob names: its campaign version, and both ends of every logged content
 * adoption or migration. A save blob is a `SaveEnvelope`, whose `state` is the `GameState`.
 */
export function lineageOf(blob: string): Lineage {
  const parsed = JSON.parse(blob) as {
    campaignId?: string;
    state?: unknown;
  };
  const state = (parsed.state ?? parsed) as {
    campaignId: string;
    campaignVersion: string;
    actionLog?: readonly { system?: string; from?: string; to?: string }[];
  };
  const versions = new Set<string>([state.campaignVersion]);
  for (const entry of state.actionLog ?? [])
    if (entry.system === "content" || entry.system === "migration") {
      if (typeof entry.from === "string") versions.add(entry.from);
      if (typeof entry.to === "string") versions.add(entry.to);
    }
  return {
    campaignId: state.campaignId,
    campaignVersion: state.campaignVersion,
    versions,
  };
}

/**
 * Every epoch a stored blob still depends on (D3 §5.5): the version it is on now, and both ends
 * of every content adoption logged since its last migration. Replay from before a migration
 * starts from the migrated state, so nothing earlier is needed to run it. A purge deletes
 * exactly the holders that depend on a deleted epoch; `lineageOf` is wider, and is what a
 * replay from the start (a branch, a load) needs.
 */
export function dependenciesOf(blob: string): Lineage {
  const lineage = lineageOf(blob);
  const parsed = JSON.parse(blob) as { state?: unknown };
  const log =
    (
      (parsed.state ?? parsed) as {
        actionLog?: readonly { system?: string; from?: string; to?: string }[];
      }
    ).actionLog ?? [];
  let start = 0;
  log.forEach((entry, index) => {
    if (entry.system === "migration") start = index + 1;
  });
  const versions = new Set<string>([lineage.campaignVersion]);
  for (const entry of log.slice(start))
    if (entry.system === "content") {
      if (typeof entry.from === "string") versions.add(entry.from);
      if (typeof entry.to === "string") versions.add(entry.to);
    }
  return { ...lineage, versions };
}

/** The version every new start of `campaignId` is admitted on, or the refusal. `open` is the
 *  request gate's answer (`ContentRuntime.check`): closed withholds everything but core. */
export function gateNewStart(
  runtime: ContentRuntime,
  operation: string,
  campaignId: string,
  playerId: string | null,
  open: boolean,
): string {
  const view = runtime.view();
  const entry = view?.entries.find((e) => e.campaignId === campaignId);
  const withheld = view?.withheld.find((e) => e.campaignId === campaignId);
  const found = entry ?? withheld;
  if (!found)
    throw new ContentRefusal(
      operation,
      open ? "unknown_campaign" : "storage_failure",
    );
  if (found.provenance !== null && !open)
    throw new ContentRefusal(operation, "storage_failure");
  if (!accessibleIn([found], playerId).has(campaignId))
    throw new ContentRefusal(operation, "forbidden");
  if (!entry)
    throw new ContentRefusal(operation, "campaign_version_unsupported");
  return entry.campaignVersion;
}

/**
 * An existing session's or save's epochs, checked before anything is served from them. A
 * campaign the current publication no longer offers at all was withdrawn, and its sessions
 * continue on what they recorded (D4 §4); one it still offers but not to this caller was revoked
 * from them (D3 §3).
 */
export async function gateExisting(
  runtime: ContentRuntime,
  operation: string,
  row: {
    readonly campaignId: string;
    readonly campaignVersion: string;
    /** Every version the operation replays through; the current one alone when absent. */
    readonly versions?: ReadonlySet<string>;
  },
  playerId: string | null,
  open: boolean,
): Promise<void> {
  // Deleted outranks every other answer: the holder is about to be purged, if it is not already.
  for (const version of row.versions ?? [row.campaignVersion])
    if (runtime.isBlocked(row.campaignId, version))
      throw new ContentRefusal(operation, "campaign_deleted");
  const view = runtime.view();
  const entries = [...(view?.entries ?? []), ...(view?.withheld ?? [])];
  const current = entries.find((e) => e.campaignId === row.campaignId);
  // Withdrawn or never published here: nothing says it is core, so it is withheld while closed.
  if (!open && (current === undefined || current.provenance !== null))
    throw new ContentRefusal(operation, "storage_failure");
  if (current && !accessibleIn([current], playerId).has(row.campaignId))
    throw new ContentRefusal(operation, "campaign_access_revoked");
  if (runtime.unsupported(row.campaignId, row.campaignVersion))
    throw new ContentRefusal(operation, "campaign_version_unsupported");
  if (!runtime.archive.resolve(row.campaignId, row.campaignVersion)) {
    await runtime.catchUp();
    if (!runtime.archive.resolve(row.campaignId, row.campaignVersion))
      throw new ContentRefusal(operation, "campaign_version_unavailable");
  }
}

/**
 * The channel `createSession` reads its offer from: the admitted version while a new start of
 * that campaign is running, the current publication's otherwise (an existing session adopting).
 */
export function admittingChannel(channel: ContentChannel): ContentChannel {
  return {
    current(scope) {
      const admission = currentAdmission();
      if (
        admission?.kind === "new" &&
        admission.campaignId === scope.campaignId
      )
        return admission.campaignVersion;
      return channel.current(scope);
    },
  };
}

/**
 * The fence, inside the caller's open transaction on `client`: does the current publication
 * still admit a write naming `lineage`? False refuses the write; the caller rolls back.
 */
export async function admits(
  client: PoolClient,
  lineage: Lineage,
): Promise<boolean> {
  const admission = currentAdmission();
  if (!admission || admission.campaignId !== lineage.campaignId) return false;
  if (!(await undeleted(client, lineage))) return false;
  await client.query("select state_seq from content_current for share");
  const head = await loadCurrent(client);
  const entry = head.entries.find((e) => e.campaignId === lineage.campaignId);
  const accessible =
    entry !== undefined &&
    accessibleIn([entry], admission.playerId).has(lineage.campaignId);

  if (admission.kind === "new")
    return (
      accessible &&
      entry.campaignVersion === admission.campaignVersion &&
      lineage.versions.size === 1 &&
      lineage.versions.has(admission.campaignVersion)
    );
  // Revoked while the write was on its way (D4 §2).
  if (entry && !accessible) return false;
  for (const version of lineage.versions)
    if (
      !admission.versions.has(version) &&
      !(accessible && entry.campaignVersion === version)
    )
      return false;
  return true;
}

/**
 * The deletion fence (D3 §5.2), inside the caller's open transaction: a shared advisory lock on
 * every epoch `lineage` names, in sorted order -- the locks a deletion takes exclusively to record
 * and to purge -- then false when any of them is deleted. A write that passes commits before the
 * deletion is recorded, and is purged with the rest; one that waited sees the deletion.
 */
export async function undeleted(
  client: PoolClient,
  lineage: Pick<Lineage, "campaignId" | "versions">,
): Promise<boolean> {
  const versions = [...lineage.versions].sort();
  for (const version of versions)
    await client.query(
      "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
      [epochLockKey(lineage.campaignId, version)],
    );
  const { rowCount } = await client.query(
    "select 1 from content_deletion_keys where epoch_key_hash = any($1::text[]) limit 1",
    [versions.map((v) => epochKeyHash(lineage.campaignId, v))],
  );
  return rowCount === 0;
}

/** Which epochs a holder depends on, kept with the holder (D3 §5.5): replaced in the holder's own
 *  write transaction, and only for epochs this database holds -- a fixture campaign that was
 *  never published has none to name. */
export async function recordDependencies(
  client: PoolClient,
  holder:
    | { readonly table: "session_epochs"; readonly sessionId: string }
    | { readonly table: "save_epochs"; readonly saveId: string }
    | { readonly table: "grant_epochs"; readonly token: string }
    | {
        readonly table: "run_epochs";
        readonly ownerId: string;
        readonly localRunId: string;
      },
  dependencies: Pick<Lineage, "campaignId" | "versions">,
): Promise<void> {
  const versions = [...dependencies.versions];
  const ids = versions.map(() => dependencies.campaignId);
  const existing = `select k.campaign_id, k.campaign_version
      from unnest($1::text[], $2::text[]) as k(campaign_id, campaign_version)
      join content_epochs e using (campaign_id, campaign_version)`;
  switch (holder.table) {
    case "session_epochs":
      await client.query("delete from session_epochs where session_id = $1", [
        holder.sessionId,
      ]);
      await client.query(
        `insert into session_epochs (session_id, campaign_id, campaign_version)
         select $3, campaign_id, campaign_version from (${existing}) d`,
        [ids, versions, holder.sessionId],
      );
      return;
    case "save_epochs":
      await client.query("delete from save_epochs where save_id = $1", [
        holder.saveId,
      ]);
      await client.query(
        `insert into save_epochs (save_id, campaign_id, campaign_version)
         select $3, campaign_id, campaign_version from (${existing}) d`,
        [ids, versions, holder.saveId],
      );
      return;
    case "grant_epochs":
      await client.query("delete from grant_epochs where token = $1", [
        holder.token,
      ]);
      await client.query(
        `insert into grant_epochs (token, campaign_id, campaign_version)
         select $3, campaign_id, campaign_version from (${existing}) d`,
        [ids, versions, holder.token],
      );
      return;
    case "run_epochs":
      await client.query(
        "delete from run_epochs where owner_id = $1 and local_run_id = $2",
        [holder.ownerId, holder.localRunId],
      );
      await client.query(
        `insert into run_epochs (owner_id, local_run_id, campaign_id, campaign_version)
         select $3, $4, campaign_id, campaign_version from (${existing}) d`,
        [ids, versions, holder.ownerId, holder.localRunId],
      );
      return;
  }
}

/**
 * The D4 §3 table: every route that can mint a session at revision 0 or insert an offline grant,
 * and the admission it gives the write. `admission.test.ts` fails when a route reaching
 * `createSession`, `branchSession`, `loadGame` or a grant insert is missing from it.
 */
export const D4_ENTRY_POINTS = {
  "POST /api/sessions": "new",
  "POST /api/offline/download/:campaignId": "new or derived (with sessionId)",
  "POST /api/sessions/:id/branch": "derived",
  "POST /api/saves/:saveId/load": "derived",
  "POST /api/offline/sync": "derived from the grant",
} as const;
