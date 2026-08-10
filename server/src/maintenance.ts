/**
 * Deterministic upkeep queries with no scheduler of their own -- run once per deploy by
 * `maintenance-cli.ts`, invoked from the one-shot `migrate` container
 * (docker-entrypoint.sh) right after `node-pg-migrate up`. Replaces the old probabilistic
 * sweep in `principal.ts` (issue #12): that ran on ~1% of session mints, so it fired zero
 * times on a quiet deployment and gave no deterministic guarantee the table wouldn't grow
 * unbounded. Idempotent -- safe to run every deploy even when nothing has expired.
 */
import type { Pool } from "pg";

export async function sweepExpiredSessions(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from auth_sessions where expires_at <= now()`,
  );
  return rowCount ?? 0;
}
