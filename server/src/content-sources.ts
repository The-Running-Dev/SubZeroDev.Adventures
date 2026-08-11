/**
 * CRUD over the `content_sources` table (migration 011) -- the sources an operator has
 * added through the admin page (issue #27), on top of the one hardcoded default
 * `server/src/index.ts` always prepends. `server/src/campaigns/multi-source.ts` is the only
 * caller that reads these rows to actually fetch content; this file just persists them and
 * their last-known sync outcome.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type ContentSourceKind = "url" | "pasted";

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
  };
}

const SELECT_COLUMNS = `source_id, kind, label, url, payload, last_synced_at, last_error, campaign_count, extension_count`;

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

export async function addUrlSource(
  pool: Pool,
  label: string,
  url: string,
): Promise<ContentSourceRow> {
  const sourceId = randomUUID();
  const { rows } = await pool.query<ContentSourceDbRow>(
    `insert into content_sources (source_id, kind, label, url)
     values ($1, 'url', $2, $3)
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
    `insert into content_sources (source_id, kind, label, payload)
     values ($1, 'pasted', $2, $3)
     returning ${SELECT_COLUMNS}`,
    [sourceId, label, JSON.stringify(payload)],
  );
  return toRow(rows[0]!);
}

/** `true` if a row was actually removed -- lets the route tell "removed" from "already
 *  gone" without a separate existence check. */
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

/** Overwrites the row's last-known outcome -- not a log, the most recent Sync only. A
 *  `sourceId` that no longer exists (removed between the fetch starting and finishing) is
 *  a silent no-op rather than an error; there is nothing left to record it against. */
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
            extension_count = $4
      where source_id = $1`,
    [
      sourceId,
      outcome.ok ? null : (outcome.error ?? "unknown error"),
      outcome.campaignCount ?? null,
      outcome.extensionCount ?? null,
    ],
  );
}
