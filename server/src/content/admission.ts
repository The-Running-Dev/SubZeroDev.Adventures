/**
 * Admission (engine plan 54, D4 §2-§3, D3 §5.2): which epoch a write may name, decided once at
 * the route and checked again inside the write's own transaction.
 *
 * - **The gate** runs before the store is called. A new start is refused when its campaign is not
 *   in the current publication (404), not reachable by the caller (403), or held on an epoch this
 *   process cannot run (409). An existing session or save is refused when its campaign was revoked
 *   from the caller (403 `campaign_access_revoked`), and when its epoch cannot run here (409).
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
import { loadCurrent } from "./epoch-store.js";
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
  row: { readonly campaignId: string; readonly campaignVersion: string },
  playerId: string | null,
  open: boolean,
): Promise<void> {
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
  for (const version of [...lineage.versions].sort())
    await client.query(
      "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
      [epochLockKey(lineage.campaignId, version)],
    );
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
