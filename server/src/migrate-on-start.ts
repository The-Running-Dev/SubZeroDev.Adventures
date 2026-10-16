/**
 * Schema migrations run by the API process itself, before it listens -- the alternative to
 * the one-shot `migrate` container (docker-entrypoint.sh), opted into with
 * `MIGRATE_ON_START=true` (index.ts). Issue #9, stage 3: a workload behind Platform's edge
 * brings its own schema up on start rather than relying on a sibling container to have run
 * first.
 *
 * Two API processes starting together must not both migrate. They serialize on a
 * session-level Postgres advisory lock, taken with `pg_advisory_lock` -- which *waits* --
 * on the same connection the migrations then run on. The second process blocks until the
 * first has finished, then finds nothing pending and carries on. node-pg-migrate's own lock
 * is `pg_try_advisory_lock`, which fails the run outright instead of waiting, so it is
 * switched off (`noLock`) for the run under this one.
 *
 * The lock key is node-pg-migrate's own, so this path and the `migrate` CLI exclude each
 * other too: a CLI run that overlaps a starting API fails fast on its try-lock rather than
 * racing it.
 */
import type { Pool } from "pg";
import { runner } from "node-pg-migrate";

/** node-pg-migrate's lock key (`PG_MIGRATE_LOCK_ID` in its runner). Not exported by the
 *  package, so it is restated here; `migrate-on-start.test.ts` holds it against the CLI. */
export const MIGRATION_LOCK_KEY = "7241865325823964";

export interface MigrateOnStartOptions {
  /** The migrations directory. Relative paths resolve against the working directory,
   *  exactly as they do for the `migrate` CLI -- both image targets set WORKDIR so
   *  `migrations/` sits directly beneath it. */
  dir: string;
  /** Where progress goes. Defaults to the console, like the CLI. */
  log?: (message: string) => void;
}

/** Applies every pending migration, holding the advisory lock for the whole run. Settings
 *  match the CLI's defaults (`pgmigrations` table, order checked, one transaction for the
 *  batch) so a schema brought up either way is the same schema. */
export async function migrateOnStart(
  pool: Pool,
  options: MigrateOnStartOptions,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    await runner({
      dbClient: client,
      dir: options.dir,
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      checkOrder: true,
      singleTransaction: true,
      noLock: true,
      log: options.log ?? console.log,
    });
    await client.query("select pg_advisory_unlock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    client.release();
  } catch (error) {
    // Destroying the connection ends the session, and a session-level advisory lock ends
    // with it -- so a failed run releases the lock without an unlock that could fail on
    // top of the original error and hide it.
    client.release(true);
    throw error;
  }
}
