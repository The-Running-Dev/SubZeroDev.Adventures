/**
 * Session captures: a played session kept as the engine's `ReplayFixture`
 * (`SessionLayer.captureSession`, engine spec 08), stored under the obligations 08 §8 leaves to
 * the host. `docs/session-capture.md` is the design; this is the only module that reads or
 * writes `session_captures`, apart from the two that delete from it wholesale (an account's
 * `on delete cascade`, and `content/deletion.ts`'s purge).
 *
 * - The mapping to an account is `player_id`, a column beside the fixture. The fixture's own
 *   `name` is `capture-<capture id>`, a random id derived from nothing about the session, the
 *   profile or the account (08 §2.1).
 * - Every read filters on `expires_at`; `sweepExpiredCaptures` deletes what is past it.
 * - A fixture is never logged (08 §4). A failure is reported by the capture id and an error
 *   code only, and a database error from the insert is replaced before it can reach a log,
 *   since Postgres quotes a failing row's values in its `detail`.
 * - Promotion to the engine's committed corpus is manual and reviewed (08 §7). Nothing here
 *   automates it.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { SessionLayer } from "@the-running-dev/game-engine";

export type ReplayFixture = Awaited<ReturnType<SessionLayer["captureSession"]>>;

export type CaptureTrigger = "report" | "fault";

/** What every listing shows: never the fixture. */
export interface CaptureSummary {
  readonly captureId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly campaignId: string;
  readonly trigger: CaptureTrigger;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StoredCapture extends CaptureSummary {
  readonly fixture: ReplayFixture;
}

/** The decided default (2026-11-01), overridden by `CAPTURE_RETENTION_DAYS`. */
export const DEFAULT_CAPTURE_RETENTION_DAYS = 30;

/** A capture failed to be stored. Carries the capture id and a code, never the fixture. */
export class CaptureStorageError extends Error {
  readonly captureId: string;
  readonly code: string;
  constructor(captureId: string, code: string) {
    super(`capture ${captureId} was not stored (${code})`);
    this.name = "CaptureStorageError";
    this.captureId = captureId;
    this.code = code;
  }
}

/** Every epoch the fixture replays through: the one it starts on and each adoption target. */
export function fixtureVersions(fixture: ReplayFixture): string[] {
  const versions = new Set<string>([fixture.campaignVersion]);
  for (const submission of fixture.submissions)
    if ("adopt" in submission) versions.add(submission.adopt);
  return [...versions];
}

const SUMMARY_COLUMNS = `capture_id, player_id, session_id, campaign_id, trigger, created_at, expires_at`;

function toSummary(row: Record<string, unknown>): CaptureSummary {
  return {
    captureId: row.capture_id as string,
    playerId: row.player_id as string,
    sessionId: row.session_id as string,
    campaignId: row.campaign_id as string,
    trigger: row.trigger as CaptureTrigger,
    createdAt: (row.created_at as Date).toISOString(),
    expiresAt: (row.expires_at as Date).toISOString(),
  };
}

/**
 * Captures `sessionId` and stores it under `playerId`. The engine's refusals
 * (`unknown_session`, `invalid_state`, `unknown_campaign`) propagate as the `SessionStoreError`
 * it threw, and nothing is stored. A `fault` capture of a session that already has one stores
 * nothing and answers `undefined`.
 */
export async function takeCapture(
  pool: Pool,
  layer: SessionLayer,
  request: {
    readonly sessionId: string;
    readonly playerId: string;
    readonly trigger: CaptureTrigger;
    readonly retentionDays: number;
  },
): Promise<CaptureSummary | undefined> {
  const captureId = randomUUID();
  const fixture = await layer.captureSession(
    request.sessionId,
    `capture-${captureId}`,
  );
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await pool.query(
      `insert into session_captures
         (capture_id, player_id, session_id, campaign_id, campaign_versions, trigger,
          fixture, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8))
       on conflict do nothing
       returning ${SUMMARY_COLUMNS}`,
      [
        captureId,
        request.playerId,
        request.sessionId,
        fixture.config.campaignId,
        fixtureVersions(fixture),
        request.trigger,
        JSON.stringify(fixture),
        request.retentionDays,
      ],
    ));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new CaptureStorageError(
      captureId,
      typeof code === "string" ? code : "unknown",
    );
  }
  return rows[0] && toSummary(rows[0]);
}

/** Unexpired captures, newest first: one player's, or every player's when `playerId` is null. */
export async function listCaptures(
  pool: Pool,
  playerId: string | null,
): Promise<CaptureSummary[]> {
  const { rows } = await pool.query(
    `select ${SUMMARY_COLUMNS} from session_captures
      where expires_at > now() and ($1::uuid is null or player_id = $1)
      order by created_at desc`,
    [playerId],
  );
  return rows.map(toSummary);
}

/** One unexpired capture, fixture included. Callers check who may read it. */
export async function readCapture(
  pool: Pool,
  captureId: string,
): Promise<StoredCapture | undefined> {
  const { rows } = await pool.query(
    `select ${SUMMARY_COLUMNS}, fixture from session_captures
      where capture_id = $1 and expires_at > now()`,
    [captureId],
  );
  const row = rows[0];
  if (!row) return undefined;
  return { ...toSummary(row), fixture: row.fixture as ReplayFixture };
}

/** The owner of an unexpired capture, or undefined when there is none. */
export async function captureOwner(
  pool: Pool,
  captureId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ player_id: string }>(
    `select player_id from session_captures
      where capture_id = $1 and expires_at > now()`,
    [captureId],
  );
  return rows[0]?.player_id;
}

export async function deleteCapture(
  pool: Pool,
  captureId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from session_captures where capture_id = $1`,
    [captureId],
  );
  return (rowCount ?? 0) > 0;
}

/** Every capture of one player, expired or not: deletion on request. */
export async function deleteCapturesOf(
  pool: Pool,
  playerId: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from session_captures where player_id = $1`,
    [playerId],
  );
  return rowCount ?? 0;
}

/** When the player opted in to fault capture, or null when they have not. */
export async function faultCaptureConsent(
  pool: Pool,
  playerId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{
    fault_capture_consented_at: Date | null;
  }>(`select fault_capture_consented_at from players where player_id = $1`, [
    playerId,
  ]);
  return rows[0]?.fault_capture_consented_at?.toISOString() ?? null;
}

/** Records or withdraws consent. Granting again keeps the original timestamp. */
export async function setFaultCaptureConsent(
  pool: Pool,
  playerId: string,
  consent: boolean,
): Promise<string | null> {
  const { rows } = await pool.query<{
    fault_capture_consented_at: Date | null;
  }>(
    consent
      ? `update players set fault_capture_consented_at = coalesce(fault_capture_consented_at, now())
          where player_id = $1 returning fault_capture_consented_at`
      : `update players set fault_capture_consented_at = null
          where player_id = $1 returning fault_capture_consented_at`,
    [playerId],
  );
  return rows[0]?.fault_capture_consented_at?.toISOString() ?? null;
}

/**
 * What `composition.ts`'s record sink calls when a session emits an `error`-severity event
 * (08 §3): captures it when its owner opted in and it has no fault capture yet. Runs after the
 * faulting command released the session, never inside it. Every failure is reported through
 * `warn` by code alone, and never thrown: a capture must not turn a fault into a second one.
 */
export function faultCapture(
  pool: Pool,
  retentionDays: number,
  warn: (message: string) => void,
): (layer: SessionLayer, sessionId: string) => Promise<void> {
  return async (layer, sessionId) => {
    try {
      const { rows } = await pool.query<{ profile_id: string }>(
        `select s.profile_id from sessions s
           join players p on p.player_id = s.profile_id
          where s.session_id = $1 and p.fault_capture_consented_at is not null
            and not exists (select 1 from session_captures c
                             where c.session_id = s.session_id and c.trigger = 'fault')`,
        [sessionId],
      );
      const owner = rows[0]?.profile_id;
      if (owner === undefined) return;
      await takeCapture(pool, layer, {
        sessionId,
        playerId: owner,
        trigger: "fault",
        retentionDays,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      warn(
        `fault capture failed: ${typeof code === "string" ? code : "unknown"}`,
      );
    }
  };
}
