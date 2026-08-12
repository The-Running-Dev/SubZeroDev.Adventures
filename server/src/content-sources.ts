/**
 * CRUD over the `content_sources` table (migrations 011, 013) -- both the sources an operator
 * has added through the admin page (issue #27) and, since 013, the campaigns and extensions a
 * signed-in player has submitted for themselves. `owner_player_id null` is what keeps meaning
 * "an admin-curated row" exactly as it always has: live the moment it validates, never in the
 * moderation queue (`content_sources_owner_shape`, migration 013, enforces this in the schema
 * rather than in application code). `server/src/campaigns/multi-source.ts` is the only caller
 * that reads these rows to actually fetch content; this file just persists them and their
 * last-known sync outcome.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type ContentSourceKind = "url" | "pasted";
export type ContentSourceStatus = "pending" | "approved" | "rejected";
export type ContentSourceVisibility = "private" | "public";

export interface ContentSourceRow {
  readonly id: string;
  readonly kind: ContentSourceKind;
  readonly label: string;
  /** Set only for `kind: "url"`. */
  readonly url?: string;
  /** Set only for `kind: "pasted"` -- a parsed campaign or extension JSON object. */
  readonly payload?: unknown;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
  /** Absent for an admin-curated row -- see this file's header. */
  readonly ownerPlayerId?: string;
  readonly status: ContentSourceStatus;
  readonly visibility: ContentSourceVisibility;
  readonly reviewNote?: string;
  readonly reviewedAt?: string;
  readonly reviewedBy?: string;
  /** Set when this row loaded and validated fine on its own but was excluded from a combined
   *  build it collided with -- distinct from `lastError`, which means the row's own load
   *  failed outright. See migration 013's column comment. */
  readonly quarantineReason?: string;
  readonly quarantinedAt?: string;
}

export interface SourceOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
}

interface ContentSourceDbRow {
  source_id: string;
  kind: string;
  label: string;
  url: string | null;
  payload: unknown;
  last_synced_at: Date | null;
  last_error: string | null;
  campaign_count: number | null;
  extension_count: number | null;
  owner_player_id: string | null;
  status: string;
  visibility: string;
  review_note: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  quarantine_reason: string | null;
  quarantined_at: Date | null;
}

function toRow(row: ContentSourceDbRow): ContentSourceRow {
  return {
    id: row.source_id,
    kind: row.kind as ContentSourceKind,
    label: row.label,
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.payload !== null ? { payload: row.payload } : {}),
    ...(row.last_synced_at
      ? { lastSyncedAt: row.last_synced_at.toISOString() }
      : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.campaign_count !== null
      ? { campaignCount: row.campaign_count }
      : {}),
    ...(row.extension_count !== null
      ? { extensionCount: row.extension_count }
      : {}),
    ...(row.owner_player_id !== null
      ? { ownerPlayerId: row.owner_player_id }
      : {}),
    status: row.status as ContentSourceStatus,
    visibility: row.visibility as ContentSourceVisibility,
    ...(row.review_note !== null ? { reviewNote: row.review_note } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at.toISOString() } : {}),
    ...(row.reviewed_by !== null ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.quarantine_reason !== null
      ? { quarantineReason: row.quarantine_reason }
      : {}),
    ...(row.quarantined_at
      ? { quarantinedAt: row.quarantined_at.toISOString() }
      : {}),
  };
}

const SELECT_COLUMNS = `source_id, kind, label, url, payload, last_synced_at, last_error,
  campaign_count, extension_count, owner_player_id, status, visibility, review_note,
  reviewed_at, reviewed_by, quarantine_reason, quarantined_at`;

export async function listContentSources(
  pool: Pool,
): Promise<readonly ContentSourceRow[]> {
  const { rows } = await pool.query<ContentSourceDbRow>(
    `select ${SELECT_COLUMNS} from content_sources order by created_at`,
  );
  return rows.map(toRow);
}

/** One row by id, or `undefined` if it's gone. `routes/admin.ts` re-reads a row it just
 *  inserted with this, after the refresh that followed the insert: the insert's own
 *  `returning` predates `recordSourceOutcome`, so it cannot say whether *this* source
 *  loaded -- which is the difference between "your paste is broken" and "your paste is
 *  fine, some other source is broken". */
export async function getContentSource(
  pool: Pool,
  sourceId: string,
): Promise<ContentSourceRow | undefined> {
  const { rows } = await pool.query<ContentSourceDbRow>(
    `select ${SELECT_COLUMNS} from content_sources where source_id = $1`,
    [sourceId],
  );
  const row = rows[0];
  return row ? toRow(row) : undefined;
}

/** Admin-curated, exactly as before 013 -- `owner_player_id` stays null, `status`/`visibility`
 *  are set explicitly rather than left to the column defaults (which favor a fresh player
 *  submission), so this keeps meaning "live the moment it validates" regardless of what those
 *  defaults are. */
export async function addUrlSource(
  pool: Pool,
  label: string,
  url: string,
): Promise<ContentSourceRow> {
  const sourceId = randomUUID();
  const { rows } = await pool.query<ContentSourceDbRow>(
    `insert into content_sources (source_id, kind, label, url, status, visibility)
     values ($1, 'url', $2, $3, 'approved', 'public')
     returning ${SELECT_COLUMNS}`,
    [sourceId, label, url],
  );
  return toRow(rows[0]!);
}

export async function addPastedSource(
  pool: Pool,
  label: string,
  payload: unknown,
): Promise<ContentSourceRow> {
  const sourceId = randomUUID();
  const { rows } = await pool.query<ContentSourceDbRow>(
    `insert into content_sources (source_id, kind, label, payload, status, visibility)
     values ($1, 'pasted', $2, $3, 'approved', 'public')
     returning ${SELECT_COLUMNS}`,
    [sourceId, label, JSON.stringify(payload)],
  );
  return toRow(rows[0]!);
}

/** A player's own submission -- always private and unreviewed at creation, regardless of what
 *  they submit; going public only ever happens through `approveSubmission`. `kind`/`url`/
 *  `payload` mirror `addUrlSource`/`addPastedSource`'s two shapes rather than a third one, so
 *  `multi-source.ts`'s `rowToEntry` needs no submission-specific branch. */
export async function addSubmission(
  pool: Pool,
  ownerPlayerId: string,
  label: string,
  source: { kind: "url"; url: string } | { kind: "pasted"; payload: unknown },
): Promise<ContentSourceRow> {
  const sourceId = randomUUID();
  const { rows } = await pool.query<ContentSourceDbRow>(
    `insert into content_sources (source_id, kind, label, url, payload, owner_player_id)
     values ($1, $2, $3, $4, $5, $6)
     returning ${SELECT_COLUMNS}`,
    [
      sourceId,
      source.kind,
      label,
      source.kind === "url" ? source.url : null,
      source.kind === "pasted" ? JSON.stringify(source.payload) : null,
      ownerPlayerId,
    ],
  );
  return toRow(rows[0]!);
}

export async function listSubmissionsByOwner(
  pool: Pool,
  ownerPlayerId: string,
): Promise<readonly ContentSourceRow[]> {
  const { rows } = await pool.query<ContentSourceDbRow>(
    `select ${SELECT_COLUMNS} from content_sources
      where owner_player_id = $1
      order by created_at`,
    [ownerPlayerId],
  );
  return rows.map(toRow);
}

/** One player's own row, or `undefined` if it doesn't exist *or belongs to someone else* --
 *  deliberately the same outcome for both, so a route built on this answers another player's
 *  id with a 404, never a 403 that would confirm the id exists. */
export async function getOwnedSubmission(
  pool: Pool,
  sourceId: string,
  ownerPlayerId: string,
): Promise<ContentSourceRow | undefined> {
  const { rows } = await pool.query<ContentSourceDbRow>(
    `select ${SELECT_COLUMNS} from content_sources
      where source_id = $1 and owner_player_id = $2`,
    [sourceId, ownerPlayerId],
  );
  const row = rows[0];
  return row ? toRow(row) : undefined;
}

/** Every submission awaiting a moderation decision -- the admin queue. Rejected rows fall out
 *  once reviewed; an owner can resubmit them via `requestPublish`, which brings them back in. */
export async function listPendingSubmissions(
  pool: Pool,
): Promise<readonly ContentSourceRow[]> {
  const { rows } = await pool.query<ContentSourceDbRow>(
    `select ${SELECT_COLUMNS} from content_sources
      where owner_player_id is not null and status = 'pending'
      order by created_at`,
  );
  return rows.map(toRow);
}

/** Replaces an owned row's content in place -- edits go live immediately once approved (no
 *  re-review), so this deliberately leaves `status`/`visibility` untouched. `true` iff a row
 *  by this id, owned by this player, existed to update. */
export async function updateOwnedSubmission(
  pool: Pool,
  sourceId: string,
  ownerPlayerId: string,
  fields: {
    readonly label?: string;
    readonly source?:
      { kind: "url"; url: string } | { kind: "pasted"; payload: unknown };
  },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update content_sources
        set label = coalesce($3, label),
            kind = coalesce($4, kind),
            url = case when $4 = 'url' then $5 when $4 is null then url else null end,
            payload = case when $4 = 'pasted' then $6 when $4 is null then payload else null end
      where source_id = $1 and owner_player_id = $2`,
    [
      sourceId,
      ownerPlayerId,
      fields.label ?? null,
      fields.source?.kind ?? null,
      fields.source?.kind === "url" ? fields.source.url : null,
      fields.source?.kind === "pasted"
        ? JSON.stringify(fields.source.payload)
        : null,
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Moves an owned row back into the moderation queue -- from a fresh, never-reviewed
 *  submission or from `rejected` after the owner has addressed the reason why. A no-op, not
 *  an error, if it's already `pending` or already `approved`. `true` iff the row exists and
 *  is owned by this player. */
export async function requestPublish(
  pool: Pool,
  sourceId: string,
  ownerPlayerId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update content_sources
        set status = 'pending'
      where source_id = $1 and owner_player_id = $2 and status = 'rejected'`,
    [sourceId, ownerPlayerId],
  );
  if ((rowCount ?? 0) > 0) return true;
  const existing = await getOwnedSubmission(pool, sourceId, ownerPlayerId);
  return existing !== undefined;
}

/** Admin decisions -- both take the reviewing admin's `playerId` and an optional note shown
 *  back to the author. `approveSubmission` also covers *revoking* an already-public row: an
 *  admin can call it again on an `approved` row to update the note, and reject it from there
 *  to pull it back to private. */
export async function approveSubmission(
  pool: Pool,
  sourceId: string,
  reviewedBy: string,
  note?: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update content_sources
        set status = 'approved', visibility = 'public',
            review_note = $3, reviewed_at = now(), reviewed_by = $2
      where source_id = $1 and owner_player_id is not null`,
    [sourceId, reviewedBy, note ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Rejects a pending request, or revokes an already-public row -- either way the row goes (or
 *  stays) private and out of the public catalog on the next refresh. */
export async function rejectSubmission(
  pool: Pool,
  sourceId: string,
  reviewedBy: string,
  note?: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update content_sources
        set status = 'rejected', visibility = 'private',
            review_note = $3, reviewed_at = now(), reviewed_by = $2
      where source_id = $1 and owner_player_id is not null`,
    [sourceId, reviewedBy, note ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** `true` if a row was actually removed -- lets the route tell "removed" from "already
 *  gone" without a separate existence check. Used by the admin route (any row) and, scoped by
 *  the caller to `owner_player_id`, by the owner-facing delete. */
export async function removeContentSource(
  pool: Pool,
  sourceId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from content_sources where source_id = $1`,
    [sourceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function removeOwnedSubmission(
  pool: Pool,
  sourceId: string,
  ownerPlayerId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from content_sources where source_id = $1 and owner_player_id = $2`,
    [sourceId, ownerPlayerId],
  );
  return (rowCount ?? 0) > 0;
}

/** Overwrites the row's last-known outcome -- not a log, the most recent Sync only. A
 *  `sourceId` that no longer exists (removed between the fetch starting and finishing) is
 *  a silent no-op rather than an error; there is nothing left to record it against. Clears
 *  any previous quarantine: a row that loads and joins the published build cleanly this time
 *  is not quarantined anymore, whatever the last build said. */
export async function recordSourceOutcome(
  pool: Pool,
  sourceId: string,
  outcome: SourceOutcome,
): Promise<void> {
  await pool.query(
    `update content_sources
        set last_synced_at = now(),
            last_error = $2,
            campaign_count = $3,
            extension_count = $4,
            quarantine_reason = null,
            quarantined_at = null
      where source_id = $1`,
    [
      sourceId,
      outcome.ok ? null : (outcome.error ?? "unknown error"),
      outcome.campaignCount ?? null,
      outcome.extensionCount ?? null,
    ],
  );
}

/** A row that loaded and validated fine *on its own* but was excluded from the combined build
 *  it collided with -- the fail-open submission tier's outcome, distinct from `last_error`
 *  (this file's header, migration 013). Called instead of `recordSourceOutcome` for a
 *  quarantined row, so `last_error` stays clear and an author's status table doesn't say
 *  "this failed to load" about content that loaded fine. */
export async function recordQuarantine(
  pool: Pool,
  sourceId: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `update content_sources
        set last_synced_at = now(),
            quarantine_reason = $2,
            quarantined_at = now()
      where source_id = $1`,
    [sourceId, reason],
  );
}
