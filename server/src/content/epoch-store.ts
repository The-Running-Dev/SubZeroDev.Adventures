/**
 * The durable half of content epochs (engine plan 54, §3.1-§3.3): what this server has ever
 * published, and which publication is current. Insert-only except for `content_current`, which
 * moves by compare-and-set from the publication it was read at, under one advisory lock, so two
 * processes refreshing at once cannot both win.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  canonicalDigest,
  type PortableCatalog,
  type StoredEpoch,
} from "@the-running-dev/game-engine";
import type { CampaignProvenance } from "../composition.js";

/** The advisory-lock key every content publication takes. Arbitrary; fixed forever. */
export const PUBLICATION_LOCK = 5_400_054;

export type PublicationReason =
  "refresh" | "rollback" | "withdrawal" | "deletion";

export interface EpochRow {
  readonly stored: StoredEpoch;
  readonly migration: unknown;
  readonly extensionsDigest: string | undefined;
  readonly extensions: readonly {
    readonly id: string;
    readonly extends: string;
  }[];
}

export interface EntryRow {
  readonly campaignId: string;
  readonly campaignVersion: string;
  readonly catalog: PortableCatalog;
  /** Null for core. */
  readonly provenance: CampaignProvenance | null;
}

export interface CurrentEntryRow extends EntryRow {
  /** The held epoch's content digest, so "the same publication" means the same content. */
  readonly digest: string;
}

export interface CurrentRow {
  readonly publicationId: string | null;
  readonly stateSeq: number;
  readonly entries: readonly CurrentEntryRow[];
}

export interface NewEpoch extends EpochRow {
  readonly engineVersion: string;
  /** The submission sources it was composed from (D3 §5.5). */
  readonly sourceIds: readonly string[];
}

export type CommitResult =
  | {
      readonly ok: true;
      readonly publicationId: string;
      readonly stateSeq: number;
    }
  /** `content_current` moved since `parent` was read. */
  | { readonly ok: false; readonly reason: "stale_parent" }
  /** Another process holds this key under a different digest. */
  | {
      readonly ok: false;
      readonly reason: "content_version_conflict";
      readonly campaignId: string;
      readonly campaignVersion: string;
    }
  /** The key was permanently deleted (D3 §5.4); it is never published again. */
  | {
      readonly ok: false;
      readonly reason: "campaign_version_deleted";
      readonly campaignId: string;
      readonly campaignVersion: string;
    }
  /** An epoch was composed from a deleted source. */
  | {
      readonly ok: false;
      readonly reason: "source_deleted";
      readonly sourceId: string;
    };

interface EpochDbRow {
  campaign_id: string;
  campaign_version: string;
  digest: string;
  epoch: StoredEpoch["form"];
  migration: unknown;
  reserved_keys: readonly string[];
  published_kind_id: StoredEpoch["publication"]["kindId"];
  published_kind_version: string;
  extensions_digest: string | null;
  extensions: EpochRow["extensions"];
}

function epochOf(row: EpochDbRow): EpochRow {
  return {
    stored: {
      form: row.epoch,
      publication: {
        kindId: row.published_kind_id,
        kindVersion: row.published_kind_version,
        reservedKeys: row.reserved_keys,
      },
      digest: row.digest,
    },
    migration: row.migration,
    extensionsDigest: row.extensions_digest ?? undefined,
    extensions: row.extensions,
  };
}

/** Every epoch ever published, in the order publications first named them (§3.3). */
export async function loadEpochs(pool: Pool): Promise<readonly EpochRow[]> {
  const { rows } = await pool.query<EpochDbRow>(
    `select e.* from content_epochs e
       join content_publications p on p.publication_id = e.first_publication_id
      order by p.seq, e.campaign_id`,
  );
  return rows.map(epochOf);
}

/** The identity of every held key, for the candidate's conflict check. */
export async function loadEpochDigests(
  pool: Pool,
): Promise<
  ReadonlyMap<
    string,
    { readonly digest: string; readonly extensionsDigest: string | undefined }
  >
> {
  const { rows } = await pool.query<{
    campaign_id: string;
    campaign_version: string;
    digest: string;
    extensions_digest: string | null;
  }>(
    "select campaign_id, campaign_version, digest, extensions_digest from content_epochs",
  );
  return new Map(
    rows.map((row) => [
      epochKey(row.campaign_id, row.campaign_version),
      {
        digest: row.digest,
        extensionsDigest: row.extensions_digest ?? undefined,
      },
    ]),
  );
}

export function epochKey(campaignId: string, campaignVersion: string): string {
  return `${campaignId}\u0000${campaignVersion}`;
}

/** The contentless identity of a key, as the deletion ledger holds it (D3 §5.4). */
export function epochKeyHash(
  campaignId: string,
  campaignVersion: string,
): string {
  return canonicalDigest([campaignId, campaignVersion]);
}

/** The contentless identity of a whole campaign: what `content_deleted_campaigns` holds once
 *  every epoch of it was purged. */
export function campaignHash(campaignId: string): string {
  return canonicalDigest(["campaign", campaignId]);
}

/** Every deleted key's hash. */
export async function loadDeletedKeyHashes(
  pool: Pool | PoolClient,
): Promise<ReadonlySet<string>> {
  const { rows } = await pool.query<{ epoch_key_hash: string }>(
    "select epoch_key_hash from content_deletion_keys",
  );
  return new Set(rows.map((row) => row.epoch_key_hash));
}

export async function loadCurrent(
  pool: Pool | PoolClient,
): Promise<CurrentRow> {
  const current = await pool.query<{
    publication_id: string | null;
    state_seq: string;
  }>("select publication_id, state_seq from content_current");
  const head = current.rows[0]!;
  if (head.publication_id === null)
    return {
      publicationId: null,
      stateSeq: Number(head.state_seq),
      entries: [],
    };
  const { rows } = await pool.query<{
    campaign_id: string;
    campaign_version: string;
    catalog: PortableCatalog;
    provenance: CampaignProvenance | null;
    digest: string;
  }>(
    `select pe.campaign_id, pe.campaign_version, pe.catalog, pe.provenance, e.digest
       from content_publication_entries pe
       join content_epochs e
         on e.campaign_id = pe.campaign_id and e.campaign_version = pe.campaign_version
      where pe.publication_id = $1 order by pe.position`,
    [head.publication_id],
  );
  return {
    publicationId: head.publication_id,
    stateSeq: Number(head.state_seq),
    entries: rows.map((row) => ({
      campaignId: row.campaign_id,
      campaignVersion: row.campaign_version,
      catalog: row.catalog,
      provenance: row.provenance,
      digest: row.digest,
    })),
  };
}

/** The entries of one past publication, for a rollback (§3.5). */
export async function loadPublicationEntries(
  pool: Pool,
  publicationId: string,
): Promise<readonly EntryRow[] | undefined> {
  const exists = await pool.query(
    "select 1 from content_publications where publication_id = $1",
    [publicationId],
  );
  if (exists.rowCount === 0) return undefined;
  const { rows } = await pool.query<{
    campaign_id: string;
    campaign_version: string;
    catalog: PortableCatalog;
    provenance: CampaignProvenance | null;
  }>(
    `select campaign_id, campaign_version, catalog, provenance
       from content_publication_entries where publication_id = $1 order by position`,
    [publicationId],
  );
  return rows.map((row) => ({
    campaignId: row.campaign_id,
    campaignVersion: row.campaign_version,
    catalog: row.catalog,
    provenance: row.provenance,
  }));
}

/** The catalog an epoch was last published with: an epoch no publication offers any more
 *  still has one, from the last publication that did. */
export async function loadEpochCatalog(
  pool: Pool,
  campaignId: string,
  campaignVersion: string,
): Promise<PortableCatalog | undefined> {
  const { rows } = await pool.query<{ catalog: PortableCatalog }>(
    `select pe.catalog from content_publication_entries pe
       join content_publications p using (publication_id)
      where pe.campaign_id = $1 and pe.campaign_version = $2
      order by p.seq desc limit 1`,
    [campaignId, campaignVersion],
  );
  return rows[0]?.catalog;
}

export interface PublicationInput {
  readonly parent: string | null;
  readonly reason: PublicationReason;
  readonly createdBy: string;
  readonly epochs: readonly NewEpoch[];
  readonly entries: readonly EntryRow[];
}

/**
 * Step 2 of §3.2, in one transaction: insert the new epochs (an identical one already held is
 * left alone; a different one under the same key refuses everything), the publication and its
 * entries, then move `content_current` from `parent` -- or refuse, if it is no longer there.
 */
export async function commitPublication(
  pool: Pool,
  input: PublicationInput,
): Promise<CommitResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await commitPublicationIn(client, input);
    await client.query(result.ok ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * `commitPublication` inside the caller's open transaction, which the deletion purge's own
 * `reason: deletion` publication commits in (D3 §5.3). On a refusal the caller rolls back.
 * A deleted key or source refuses it under the publication lock, which recording a deletion
 * also takes, so no publication commits a key a deletion has already recorded (§5.2).
 */
export async function commitPublicationIn(
  client: PoolClient,
  input: PublicationInput,
): Promise<CommitResult> {
  await client.query("select pg_advisory_xact_lock($1)", [PUBLICATION_LOCK]);
  const head = await client.query<{ publication_id: string | null }>(
    "select publication_id from content_current for update",
  );
  if (head.rows[0]!.publication_id !== input.parent)
    return { ok: false, reason: "stale_parent" };

  const keys = [
    ...input.epochs.map((e) => ({
      campaignId: e.stored.form.campaign.id,
      campaignVersion: e.stored.form.campaign.version,
    })),
    ...input.entries,
  ];
  const deletedKeys = await client.query<{ epoch_key_hash: string }>(
    "select epoch_key_hash from content_deletion_keys where epoch_key_hash = any($1)",
    [keys.map((k) => epochKeyHash(k.campaignId, k.campaignVersion))],
  );
  if (deletedKeys.rowCount !== 0) {
    const hashes = new Set(deletedKeys.rows.map((r) => r.epoch_key_hash));
    const key = keys.find((k) =>
      hashes.has(epochKeyHash(k.campaignId, k.campaignVersion)),
    )!;
    return {
      ok: false,
      reason: "campaign_version_deleted",
      campaignId: key.campaignId,
      campaignVersion: key.campaignVersion,
    };
  }
  const deletedSource = await client.query<{ source_id: string }>(
    "select source_id from content_deletions where source_id = any($1::uuid[]) limit 1",
    [input.epochs.flatMap((e) => e.sourceIds)],
  );
  if (deletedSource.rowCount !== 0)
    return {
      ok: false,
      reason: "source_deleted",
      sourceId: deletedSource.rows[0]!.source_id,
    };

  const publicationId = randomUUID();
  await client.query(
    `insert into content_publications (publication_id, parent_publication_id, reason, created_by)
     values ($1, $2, $3, $4)`,
    [publicationId, input.parent, input.reason, input.createdBy],
  );

  for (const epoch of input.epochs) {
    const { form, publication, digest } = epoch.stored;
    const inserted = await client.query(
      `insert into content_epochs
         (campaign_id, campaign_version, digest, epoch, migration, reserved_keys,
          first_publication_id, published_kind_id, published_kind_version,
          published_engine_version, extensions_digest, extensions)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (campaign_id, campaign_version) do nothing`,
      [
        form.campaign.id,
        form.campaign.version,
        digest,
        JSON.stringify(form),
        epoch.migration === undefined || epoch.migration === null
          ? null
          : JSON.stringify(epoch.migration),
        JSON.stringify(publication.reservedKeys),
        publicationId,
        publication.kindId,
        publication.kindVersion,
        epoch.engineVersion,
        epoch.extensionsDigest ?? null,
        JSON.stringify(epoch.extensions),
      ],
    );
    for (const sourceId of epoch.sourceIds)
      await client.query(
        `insert into content_epoch_sources (campaign_id, campaign_version, source_id)
         values ($1, $2, $3) on conflict do nothing`,
        [form.campaign.id, form.campaign.version, sourceId],
      );
    if (inserted.rowCount === 1) continue;
    const held = await client.query<{ digest: string }>(
      "select digest from content_epochs where campaign_id = $1 and campaign_version = $2",
      [form.campaign.id, form.campaign.version],
    );
    if (held.rows[0]!.digest !== digest) {
      return {
        ok: false,
        reason: "content_version_conflict",
        campaignId: form.campaign.id,
        campaignVersion: form.campaign.version,
      };
    }
  }

  for (const [position, entry] of input.entries.entries()) {
    await client.query(
      `insert into content_publication_entries
         (publication_id, campaign_id, campaign_version, position, catalog, provenance)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        publicationId,
        entry.campaignId,
        entry.campaignVersion,
        position,
        JSON.stringify(entry.catalog),
        entry.provenance === null ? null : JSON.stringify(entry.provenance),
      ],
    );
  }

  const moved = await client.query<{ state_seq: string }>(
    `update content_current set publication_id = $1, state_seq = state_seq + 1
     returning state_seq`,
    [publicationId],
  );
  return {
    ok: true,
    publicationId,
    stateSeq: Number(moved.rows[0]!.state_seq),
  };
}
