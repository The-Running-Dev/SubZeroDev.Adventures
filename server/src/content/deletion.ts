/**
 * Permanent deletion of a submission and everything that names it (engine plan 54, D3 §5.3).
 * Three steps, each idempotent, with one irreversibility point:
 *
 * 1. **Record**, in one transaction: the `content_deletions` row in state `pending`, the hash of
 *    every affected epoch key, and `state_seq` moved. From that commit on, every process refuses
 *    the content (§5.2), and nothing cancels the deletion.
 * 2. **Append** the contentless entry to the external ledger, and keep the sequence it was given.
 * 3. **Purge**, in one transaction: the dependent sessions, saves, grants, runs, receipts,
 *    session captures and achievement rows, with tombstones; the historical publication
 *    entries, replaced by markers; the epochs; the source row; a `reason: deletion` publication when the current one still
 *    names an affected epoch; and the row marked purged, its clear-text keys dropped.
 *
 * The purge does not wait for the append. Either failing leaves the row `pending`, and the
 * reconciler finishes it. This is the only module that deletes from these tables.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  dependenciesOf,
  epochLockKey,
  recordDependencies,
} from "./admission.js";
import {
  campaignHash,
  commitPublicationIn,
  epochKeyHash,
  loadCurrent,
  loadDeletedKeyHashes,
  PUBLICATION_LOCK,
} from "./epoch-store.js";
import type { ExternalLedger } from "./ledger.js";

/** Only one process reconciles at a time. Arbitrary; fixed forever. */
const RECONCILE_LOCK = 5_400_055;

export interface DeletionActor {
  readonly role: "owner" | "admin";
  readonly playerId: string;
}

/** What the delete routes are handed (`app.ts` builds it): the protocol on this process's
 *  ledger, and the retention the confirmation states. */
export interface Deletions {
  /** `deleteSource`, then a reconcile in the background (§5.3: after each deletion request). */
  remove(sourceId: string, actor: DeletionActor): Promise<"done" | "pending">;
  /** The operator's attested backup retention (D3 §7); undefined outside a deployment. */
  readonly backupRetentionDays: number | undefined;
}

interface Key {
  readonly campaignId: string;
  readonly campaignVersion: string;
}

/** The advisory-lock key a campaign's achievements are fenced on. Distinct from every
 *  `epochLockKey`, which is a two-element array. */
export function campaignLockKey(campaignId: string): string {
  return JSON.stringify([campaignId]);
}

/** A tombstone answers for 365 days (D3 §6), as a response policy: a read ignores an older one
 *  whether or not the sweep has removed it yet. */
export const TOMBSTONE_LIVE = "deleted_at > now() - interval '365 days'";

/** Removes every tombstone past its window. Run by the timer; never gates a response. */
export async function sweepTombstones(pool: Pool): Promise<void> {
  for (const table of [
    "session_tombstones",
    "save_tombstones",
    "grant_tombstones",
    "run_tombstones",
  ])
    await pool.query(`delete from ${table} where not (${TOMBSTONE_LIVE})`);
}

/**
 * Dependency rows for every session and save written before they existed (D3 §5.5), at boot.
 * A purge already finds such a holder by its own `campaign_version`; this adds the epochs its
 * adoption history names. Each row is locked while its blob is read, so a write landing
 * meanwhile is not overwritten with older dependencies. A blob that does not parse is left as
 * it was, and reported.
 */
export async function backfillDependencies(
  pool: Pool,
  warn: (message: string) => void,
): Promise<void> {
  for (const [table, key, joins] of [
    ["sessions", "session_id", "session_epochs"],
    ["saves", "save_id", "save_epochs"],
  ] as const) {
    const { rows } = await pool.query<{ id: string }>(
      `select h.${key} as id from ${table} h
        where not exists (select 1 from ${joins} j where j.${key} = h.${key})`,
    );
    for (const { id } of rows)
      await inTransaction(pool, async (client) => {
        const held = await client.query<{ blob: string }>(
          `select blob from ${table} where ${key} = $1 for update`,
          [id],
        );
        const row = held.rows[0];
        if (!row) return;
        let dependencies;
        try {
          dependencies = dependenciesOf(row.blob);
        } catch {
          warn(
            `content deletion: ${table} row has an unreadable blob; not backfilled`,
          );
          return;
        }
        await recordDependencies(
          client,
          table === "sessions"
            ? { table: "session_epochs", sessionId: id }
            : { table: "save_epochs", saveId: id },
          dependencies,
        );
      });
  }
}

/** How a grant's token is named once the grant is gone: never the token itself. */
export function grantTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Epoch locks, then campaign locks, each in sorted order, exclusively: every fenced writer
 *  takes the same ones shared. */
async function lockExclusive(
  client: PoolClient,
  keys: readonly Key[],
): Promise<void> {
  const epochs = [
    ...new Set(keys.map((k) => epochLockKey(k.campaignId, k.campaignVersion))),
  ].sort();
  for (const key of epochs)
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
  const campaigns = [
    ...new Set(keys.map((k) => campaignLockKey(k.campaignId))),
  ].sort();
  for (const key of campaigns)
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
}

/** Every held epoch whose key hash is in `hashes`: how a deletion re-recorded from the external
 *  ledger, which holds no clear-text key, finds what it deleted. */
async function epochsByHash(
  client: PoolClient,
  hashes: ReadonlySet<string>,
): Promise<Key[]> {
  if (hashes.size === 0) return [];
  const { rows } = await client.query<{
    campaign_id: string;
    campaign_version: string;
  }>("select campaign_id, campaign_version from content_epochs");
  return rows
    .map((r) => ({
      campaignId: r.campaign_id,
      campaignVersion: r.campaign_version,
    }))
    .filter((k) => hashes.has(epochKeyHash(k.campaignId, k.campaignVersion)));
}

async function epochsOfSource(
  client: PoolClient,
  sourceId: string,
): Promise<Key[]> {
  const { rows } = await client.query<{
    campaign_id: string;
    campaign_version: string;
  }>(
    `select campaign_id, campaign_version from content_epoch_sources where source_id = $1
      order by campaign_id, campaign_version`,
    [sourceId],
  );
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    campaignVersion: r.campaign_version,
  }));
}

function distinct(keys: readonly Key[]): Key[] {
  const seen = new Map<string, Key>();
  for (const key of keys)
    seen.set(epochLockKey(key.campaignId, key.campaignVersion), key);
  return [...seen.values()];
}

/** A pool, or a client already checked out of one -- the reconciler's, which holds the
 *  reconcile lock and so must do its work on that connection: on a one-connection pool a
 *  second checkout would wait for it forever. */
type Db = Pool | PoolClient;

async function inTransaction<T>(
  db: Db,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const held = "release" in db;
  const client = held ? db : await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    if (!held) client.release();
  }
}

/**
 * Step 1. Returns the deletion's id -- an existing one when this source was already recorded,
 * so a repeated request moves the same deletion forward rather than starting another. A failure
 * here leaves nothing changed.
 */
export async function recordDeletion(
  pool: Pool,
  sourceId: string,
  actor: DeletionActor,
): Promise<string> {
  return inTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [PUBLICATION_LOCK]);
    const existing = await client.query<{ deletion_id: string }>(
      "select deletion_id from content_deletions where source_id = $1",
      [sourceId],
    );
    if (existing.rowCount !== 0) return existing.rows[0]!.deletion_id;

    const keys = await epochsOfSource(client, sourceId);
    await lockExclusive(client, keys);
    const deletionId = randomUUID();
    await client.query(
      `insert into content_deletions
         (deletion_id, source_id, state, actor_role, actor_player_id, pending_keys)
       values ($1, $2, 'pending', $3, $4, $5)`,
      [
        deletionId,
        sourceId,
        actor.role,
        actor.role === "admin" ? actor.playerId : null,
        JSON.stringify(keys.map((k) => [k.campaignId, k.campaignVersion])),
      ],
    );
    for (const key of keys)
      await client.query(
        `insert into content_deletion_keys (deletion_id, epoch_key_hash)
         values ($1, $2) on conflict do nothing`,
        [deletionId, epochKeyHash(key.campaignId, key.campaignVersion)],
      );
    await client.query("update content_current set state_seq = state_seq + 1");
    return deletionId;
  });
}

/** Step 2. A no-op once the row has its external sequence. */
export async function appendDeletion(
  pool: Db,
  ledger: ExternalLedger,
  deletionId: string,
): Promise<void> {
  const { rows } = await pool.query<{
    source_id: string;
    deleted_at: Date;
    actor_role: "owner" | "admin";
    actor_player_id: string | null;
    external_seq: string | null;
    pending_keys: [string, string][] | null;
  }>(
    `select source_id, deleted_at, actor_role, actor_player_id, external_seq, pending_keys
       from content_deletions where deletion_id = $1`,
    [deletionId],
  );
  const row = rows[0];
  if (!row || row.external_seq !== null) return;
  const held = await pool.query<{ epoch_key_hash: string }>(
    "select epoch_key_hash from content_deletion_keys where deletion_id = $1",
    [deletionId],
  );
  const keyHashes = new Set(held.rows.map((r) => r.epoch_key_hash));
  for (const [id, version] of row.pending_keys ?? [])
    keyHashes.add(epochKeyHash(id, version));
  const seq = await ledger.append({
    deletionId,
    sourceId: row.source_id,
    keyHashes: [...keyHashes].sort(),
    deletedAt: row.deleted_at.toISOString(),
    actorRole: row.actor_role,
    actorPlayerId: row.actor_player_id,
  });
  await pool.query(
    `update content_deletions set external_seq = $2
      where deletion_id = $1 and external_seq is null`,
    [deletionId, seq],
  );
}

const AFFECTED = `(select * from unnest($1::text[], $2::text[]) as k(campaign_id, campaign_version))`;

/** Step 3. A no-op once the row is purged; a purge of rows already gone deletes nothing. */
export async function purgeDeletion(
  pool: Db,
  deletionId: string,
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [PUBLICATION_LOCK]);
    const { rows } = await client.query<{
      source_id: string;
      state: "pending" | "purged";
      actor_role: string;
      pending_keys: [string, string][] | null;
    }>(
      `select source_id, state, actor_role, pending_keys from content_deletions
        where deletion_id = $1 for update`,
      [deletionId],
    );
    const row = rows[0];
    if (!row || row.state === "purged") return;
    const held = await client.query<{ epoch_key_hash: string }>(
      "select epoch_key_hash from content_deletion_keys where deletion_id = $1",
      [deletionId],
    );
    const keys = distinct([
      ...(row.pending_keys ?? []).map(([campaignId, campaignVersion]) => ({
        campaignId,
        campaignVersion,
      })),
      ...(await epochsOfSource(client, row.source_id)),
      ...(await epochsByHash(
        client,
        new Set(held.rows.map((r) => r.epoch_key_hash)),
      )),
    ]);
    await lockExclusive(client, keys);
    const ids = keys.map((k) => k.campaignId);
    const versions = keys.map((k) => k.campaignVersion);

    // Dependents: every holder a join table names on an affected epoch, and every holder whose
    // own columns do -- a row written before the join tables existed, or by a fixture writer.
    const sessions = await client.query<{
      session_id: string;
      profile_id: string | null;
    }>(
      `select s.session_id, s.profile_id from sessions s
        where (s.campaign_id, s.campaign_version) in ${AFFECTED}
           or exists (select 1 from session_epochs se
                       where se.session_id = s.session_id
                         and (se.campaign_id, se.campaign_version) in ${AFFECTED})`,
      [ids, versions],
    );
    const saves = await client.query<{
      save_id: string;
      profile_id: string | null;
    }>(
      `select v.save_id, v.profile_id from saves v
        where (v.campaign_id, v.campaign_version) in ${AFFECTED}
           or exists (select 1 from save_epochs ve
                       where ve.save_id = v.save_id
                         and (ve.campaign_id, ve.campaign_version) in ${AFFECTED})`,
      [ids, versions],
    );
    const grants = await client.query<{
      token: string;
      owner_id: string | null;
    }>(
      `select g.token, g.owner_id from offline_grants g
        where (g.bundle->'portable'->'campaign'->>'id',
               g.bundle->'portable'->'campaign'->>'version') in ${AFFECTED}
           or exists (select 1 from grant_epochs ge
                       where ge.token = g.token
                         and (ge.campaign_id, ge.campaign_version) in ${AFFECTED})`,
      [ids, versions],
    );
    const tokens = grants.rows.map((g) => g.token);
    const runs = await client.query<{ owner_id: string; local_run_id: string }>(
      `select r.owner_id, r.local_run_id from offline_runs r
        where r.grant_token = any($3::uuid[])
           or exists (select 1 from run_epochs re
                       where re.owner_id = r.owner_id and re.local_run_id = r.local_run_id
                         and (re.campaign_id, re.campaign_version) in ${AFFECTED})`,
      [ids, versions, tokens],
    );

    for (const s of sessions.rows)
      await client.query(
        `insert into session_tombstones (session_id, profile_id, deletion_id)
         values ($1, $2, $3) on conflict do nothing`,
        [s.session_id, s.profile_id, deletionId],
      );
    for (const v of saves.rows)
      await client.query(
        `insert into save_tombstones (save_id, profile_id, deletion_id)
         values ($1, $2, $3) on conflict do nothing`,
        [v.save_id, v.profile_id, deletionId],
      );
    // A grant with no owner gets no tombstone: no one is authorized to learn of it (§6).
    for (const g of grants.rows)
      if (g.owner_id !== null)
        await client.query(
          `insert into grant_tombstones (token_hash, owner_id, deletion_id)
           values ($1, $2, $3) on conflict do nothing`,
          [grantTokenHash(g.token), g.owner_id, deletionId],
        );
    for (const r of runs.rows)
      await client.query(
        `insert into run_tombstones (owner_id, local_run_id, deletion_id)
         values ($1, $2, $3) on conflict do nothing`,
        [r.owner_id, r.local_run_id, deletionId],
      );

    // Receipts quote the run they accepted; runs before grants, whose token they reference
    // without a cascade; holders last, which cascades their join rows.
    const runOwners = runs.rows.map((r) => r.owner_id);
    const runIds = runs.rows.map((r) => r.local_run_id);
    await client.query(
      `delete from offline_receipts o
        using unnest($1::uuid[], $2::text[]) as r(owner_id, local_run_id)
        where o.owner_id = r.owner_id and o.receipt->>'localRunId' = r.local_run_id`,
      [runOwners, runIds],
    );
    await client.query(
      `delete from offline_runs o
        using unnest($1::uuid[], $2::uuid[]) as r(owner_id, local_run_id)
        where o.owner_id = r.owner_id and o.local_run_id = r.local_run_id`,
      [runOwners, runIds],
    );
    await client.query(
      "delete from offline_grants where token = any($1::uuid[])",
      [tokens],
    );
    // A capture replays through every epoch it names, so it goes with any of them, and with its
    // session. It gets no tombstone: its owner reads it from a listing, never by a kept id.
    await client.query(
      `delete from session_captures c
        where c.session_id = any($3::uuid[])
           or exists (select 1 from ${AFFECTED} a
                       where a.campaign_id = c.campaign_id
                         and a.campaign_version = any(c.campaign_versions))`,
      [ids, versions, sessions.rows.map((s) => s.session_id)],
    );
    await client.query("delete from saves where save_id = any($1::uuid[])", [
      saves.rows.map((v) => v.save_id),
    ]);
    await client.query(
      "delete from sessions where session_id = any($1::uuid[])",
      [sessions.rows.map((s) => s.session_id)],
    );

    // An achievement names only its campaign, so it goes when no epoch of that campaign is left.
    for (const campaignId of new Set(ids)) {
      const remaining = await client.query(
        `select 1 from content_epochs e
          where e.campaign_id = $3
            and (e.campaign_id, e.campaign_version) not in ${AFFECTED}
          limit 1`,
        [ids, versions, campaignId],
      );
      if (remaining.rowCount === 0) {
        await client.query("delete from achievements where campaign_id = $1", [
          campaignId,
        ]);
        await client.query(
          `insert into content_deleted_campaigns (campaign_hash, deletion_id)
           values ($1, $2) on conflict do nothing`,
          [campaignHash(campaignId), deletionId],
        );
      }
    }

    // The current publication stops offering what is deleted -- and anything another pending
    // deletion recorded, which `commitPublicationIn` would refuse to carry forward.
    const head = await loadCurrent(client);
    const affected = new Set(
      keys.map((k) => epochLockKey(k.campaignId, k.campaignVersion)),
    );
    const blocked = await loadDeletedKeyHashes(client);
    const named = (e: Key) =>
      affected.has(epochLockKey(e.campaignId, e.campaignVersion)) ||
      blocked.has(epochKeyHash(e.campaignId, e.campaignVersion));
    if (head.entries.some(named)) {
      const result = await commitPublicationIn(client, {
        parent: head.publicationId,
        reason: "deletion",
        createdBy: row.actor_role,
        epochs: [],
        entries: head.entries.filter((e) => !named(e)),
      });
      if (!result.ok)
        throw new Error(
          `deletion publication refused: ${result.reason} (deletion ${deletionId})`,
        );
    }

    // Each historical entry keeps its place as a marker, without its catalog metadata.
    for (const key of keys) {
      await client.query(
        `insert into content_publication_entry_markers (publication_id, epoch_key_hash, deletion_id)
         select publication_id, $3, $4 from content_publication_entries
          where campaign_id = $1 and campaign_version = $2
         on conflict do nothing`,
        [
          key.campaignId,
          key.campaignVersion,
          epochKeyHash(key.campaignId, key.campaignVersion),
          deletionId,
        ],
      );
    }
    await client.query(
      `delete from content_publication_entries
        where (campaign_id, campaign_version) in ${AFFECTED}`,
      [ids, versions],
    );
    await client.query(
      `delete from content_epochs where (campaign_id, campaign_version) in ${AFFECTED}`,
      [ids, versions],
    );
    await client.query("delete from content_sources where source_id = $1", [
      row.source_id,
    ]);
    await client.query(
      `update content_deletions
          set state = 'purged', purged_at = now(), pending_keys = null
        where deletion_id = $1`,
      [deletionId],
    );
    await client.query("update content_current set state_seq = state_seq + 1");
  });
}

/**
 * The route's whole protocol: `done` when all three steps finished (`204`), `pending` when the
 * deletion is recorded but a later step did not (`202 deletion_pending`). The content is refused
 * either way. A failure to record throws, and nothing changed.
 */
export async function deleteSource(
  pool: Pool,
  ledger: ExternalLedger,
  sourceId: string,
  actor: DeletionActor,
  warn: (message: string, error: unknown) => void = () => {},
): Promise<"done" | "pending"> {
  const deletionId = await recordDeletion(pool, sourceId, actor);
  let done = true;
  try {
    await appendDeletion(pool, ledger, deletionId);
  } catch (error) {
    done = false;
    warn(`deletion ${deletionId}: external ledger append failed`, error);
  }
  try {
    await purgeDeletion(pool, deletionId);
  } catch (error) {
    done = false;
    warn(`deletion ${deletionId}: purge failed`, error);
  }
  return done ? "done" : "pending";
}

/** Inserts an entry the database does not hold -- a backup restored to before it -- as
 *  `pending`, under the same locks recording takes. */
async function reinstate(
  pool: Db,
  entry: Awaited<ReturnType<ExternalLedger["since"]>>[number],
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [PUBLICATION_LOCK]);
    const keys = await epochsByHash(client, new Set(entry.keyHashes));
    await lockExclusive(client, keys);
    const inserted = await client.query(
      `insert into content_deletions
         (deletion_id, external_seq, source_id, state, deleted_at, actor_role, actor_player_id)
       values ($1, $2, $3, 'pending', $4, $5,
               (select player_id from players where player_id = $6::uuid))
       on conflict do nothing`,
      [
        entry.deletionId,
        entry.seq,
        entry.sourceId,
        entry.deletedAt,
        entry.actorRole,
        entry.actorPlayerId,
      ],
    );
    if (inserted.rowCount === 0) return;
    for (const hash of entry.keyHashes)
      await client.query(
        `insert into content_deletion_keys (deletion_id, epoch_key_hash)
         values ($1, $2) on conflict do nothing`,
        [entry.deletionId, hash],
      );
    await client.query("update content_current set state_seq = state_seq + 1");
  });
}

/**
 * Finishes every incomplete deletion (§5.3): pull what the external ledger holds above the
 * applied high-water sequence, append what it lacks, purge what is not purged, advance the
 * high-water sequence. `true` only when every step completed; `busy` when another process holds
 * the reconcile lock, which is not a completion this process can rely on.
 */
export async function reconcileDeletions(
  pool: Pool,
  ledger: ExternalLedger,
  warn: (message: string, error: unknown) => void = () => {},
): Promise<"done" | "busy" | "failed"> {
  const lock = await pool.connect();
  try {
    const taken = await lock.query<{ taken: boolean }>(
      "select pg_try_advisory_lock($1) as taken",
      [RECONCILE_LOCK],
    );
    if (!taken.rows[0]!.taken) return "busy";
    // Everything below runs on `lock`, the connection holding the session lock.
    try {
      let ok = true;
      const { rows } = await lock.query<{ applied_external_seq: string }>(
        "select applied_external_seq from content_current",
      );
      const applied = Number(rows[0]!.applied_external_seq);
      let highWater = applied;
      try {
        for (const entry of await ledger.since(applied)) {
          await reinstate(lock, entry);
          highWater = Math.max(highWater, entry.seq);
        }
      } catch (error) {
        warn("deletion reconcile: external ledger unreachable", error);
        return "failed";
      }

      const incomplete = await lock.query<{
        deletion_id: string;
        external_seq: string | null;
        state: string;
      }>(
        `select deletion_id, external_seq, state from content_deletions
          where external_seq is null or state <> 'purged' order by seq`,
      );
      for (const row of incomplete.rows) {
        if (row.external_seq === null)
          try {
            await appendDeletion(lock, ledger, row.deletion_id);
          } catch (error) {
            ok = false;
            warn(
              `deletion ${row.deletion_id}: external ledger append failed`,
              error,
            );
          }
        if (row.state !== "purged")
          try {
            await purgeDeletion(lock, row.deletion_id);
          } catch (error) {
            ok = false;
            warn(`deletion ${row.deletion_id}: purge failed`, error);
          }
      }
      if (highWater !== applied)
        await lock.query(
          `update content_current set applied_external_seq = greatest(applied_external_seq, $1)`,
          [highWater],
        );
      return ok ? "done" : "failed";
    } finally {
      await lock.query("select pg_advisory_unlock($1)", [RECONCILE_LOCK]);
    }
  } finally {
    lock.release();
  }
}
