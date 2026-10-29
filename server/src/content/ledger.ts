/**
 * The external deletion ledger (engine plan 54, D3 §5.3-§5.4): a copy of every deletion that
 * outlives the database it was recorded in. A backup restored to before a deletion gets it back
 * from here as `pending`, so the content is refused before it is served and purged again.
 *
 * Contentless, like `content_deletions`: an entry holds the deletion's id, the deleted source's
 * id, the hash of each deleted epoch key, when, and who. Never a clear-text key, title or string.
 * Append-only and idempotent by `deletion_id`, so the reconciler can repeat an append it is not
 * sure landed.
 *
 * The store is a second Postgres database on its own host (`LEDGER_DATABASE_URL`), reached
 * through the `pg` client this server already depends on -- the decision is in `CLAUDE.md`,
 * 2026-10-29. Unset is not "no ledger": it is a ledger that cannot be reached, so the
 * reconciler fails and private content stays withheld, as the protocol requires.
 */
import { Pool } from "pg";

export interface LedgerEntry {
  readonly deletionId: string;
  readonly sourceId: string;
  readonly keyHashes: readonly string[];
  readonly deletedAt: string;
  readonly actorRole: "owner" | "admin";
  /** The admin's player id; null for an owner's own deletion. */
  readonly actorPlayerId: string | null;
}

export interface StoredLedgerEntry extends LedgerEntry {
  /** The ledger's own sequence, which `content_current.applied_external_seq` tracks. */
  readonly seq: number;
}

export interface ExternalLedger {
  /** Appends `entry`, or finds it already there; either way, its sequence. */
  append(entry: LedgerEntry): Promise<number>;
  /** Every entry above `seq`, in sequence order. */
  since(seq: number): Promise<readonly StoredLedgerEntry[]>;
  close(): Promise<void>;
}

/** For tests: a ledger that lives as long as the process. */
export function createMemoryLedger(): ExternalLedger & {
  /** While set, every call fails as an unreachable store would. */
  unreachable: boolean;
} {
  const entries: StoredLedgerEntry[] = [];
  const ledger = {
    unreachable: false,
    async append(entry: LedgerEntry) {
      if (ledger.unreachable) throw new Error("ledger unreachable");
      const held = entries.find((e) => e.deletionId === entry.deletionId);
      if (held) return held.seq;
      const stored = { ...entry, seq: entries.length + 1 };
      entries.push(stored);
      return stored.seq;
    },
    async since(seq: number) {
      if (ledger.unreachable) throw new Error("ledger unreachable");
      return entries.filter((e) => e.seq > seq);
    },
    async close() {},
  };
  return ledger;
}

/** What a deployment without `LEDGER_DATABASE_URL` runs on: every call fails, so nothing
 *  private is served until one is configured. */
export function createUnreachableLedger(): ExternalLedger {
  const refuse = () =>
    Promise.reject(
      new Error(
        "LEDGER_DATABASE_URL is not set: the deletion ledger is unreachable",
      ),
    );
  return { append: refuse, since: refuse, close: async () => {} };
}

interface LedgerRow {
  seq: string;
  deletion_id: string;
  source_id: string;
  key_hashes: string[];
  deleted_at: Date;
  actor_role: "owner" | "admin";
  actor_player_id: string | null;
}

/**
 * The deployed ledger. Its database has no migration runner, so the one table is created on
 * first use; it is never altered, and nothing ever updates or deletes a row of it.
 */
export function createPostgresLedger(connectionString: string): ExternalLedger {
  // Bounded, so a boot whose first reconcile cannot reach the ledger fails it in seconds and
  // serves core content, rather than waiting on the operating system's connect timeout.
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  let created: Promise<void> | undefined;
  const ensure = () =>
    (created ??= pool
      .query(
        `create table if not exists content_deletion_ledger (
           seq             bigint generated always as identity primary key,
           deletion_id     uuid not null unique,
           source_id       uuid not null,
           key_hashes      jsonb not null,
           deleted_at      timestamptz not null,
           actor_role      text not null check (actor_role in ('owner', 'admin')),
           actor_player_id uuid
         )`,
      )
      .then(
        () => {},
        (error: unknown) => {
          created = undefined;
          throw error;
        },
      ));
  return {
    async append(entry) {
      await ensure();
      await pool.query(
        `insert into content_deletion_ledger
           (deletion_id, source_id, key_hashes, deleted_at, actor_role, actor_player_id)
         values ($1, $2, $3, $4, $5, $6) on conflict (deletion_id) do nothing`,
        [
          entry.deletionId,
          entry.sourceId,
          JSON.stringify(entry.keyHashes),
          entry.deletedAt,
          entry.actorRole,
          entry.actorPlayerId,
        ],
      );
      const { rows } = await pool.query<{ seq: string }>(
        "select seq from content_deletion_ledger where deletion_id = $1",
        [entry.deletionId],
      );
      return Number(rows[0]!.seq);
    },
    async since(seq) {
      await ensure();
      const { rows } = await pool.query<LedgerRow>(
        `select seq, deletion_id, source_id, key_hashes, deleted_at, actor_role, actor_player_id
           from content_deletion_ledger where seq > $1 order by seq`,
        [seq],
      );
      return rows.map((row) => ({
        seq: Number(row.seq),
        deletionId: row.deletion_id,
        sourceId: row.source_id,
        keyHashes: row.key_hashes,
        deletedAt: row.deleted_at.toISOString(),
        actorRole: row.actor_role,
        actorPlayerId: row.actor_player_id,
      }));
    },
    close: () => pool.end(),
  };
}
