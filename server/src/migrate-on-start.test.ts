/**
 * Migrate-on-start against a real Postgres (issue #9, stage 3). Each test migrates a
 * database of its own, created and dropped here, so the shared `DATABASE_URL` database the
 * other integration suites truncate is never migrated twice or left half-built.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runner } from "node-pg-migrate";
import { MIGRATION_LOCK_KEY, migrateOnStart } from "./migrate-on-start.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const migrationsDir = join(import.meta.dirname, "..", "migrations");
const migrationCount = readdirSync(migrationsDir).filter((file) =>
  file.endsWith(".sql"),
).length;
const quiet = () => {};

describe("the advisory lock key", () => {
  it("is node-pg-migrate's own, so the CLI and the server exclude each other", () => {
    const require = createRequire(import.meta.url);
    const runnerSource = readFileSync(
      join(dirname(require.resolve("node-pg-migrate")), "runner.js"),
      "utf8",
    );

    expect(runnerSource).toContain(
      `PG_MIGRATE_LOCK_ID = ${MIGRATION_LOCK_KEY};`,
    );
  });
});

describeIfDb("migrateOnStart", () => {
  let admin: Pool;
  let scratchName: string;
  let scratch: Pool;

  beforeEach(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    scratchName = `migrate_on_start_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${scratchName}`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${scratchName}`;
    scratch = new Pool({ connectionString: url.toString(), max: 10 });
  });

  afterEach(async () => {
    await scratch.end();
    // pg-pool's end() resolves once its clients leave the pool, not once their backends
    // exit; dropping with (force) while one is still closing terminates it, and the
    // 57P01 surfaces as an unhandled error. Wait for the backends to go first.
    for (let attempt = 0; attempt < 50; attempt++) {
      const { rows } = await admin.query<{ count: string }>(
        "select count(*) from pg_stat_activity where datname = $1",
        [scratchName],
      );
      if (Number(rows[0]!.count) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await admin.query(`drop database if exists ${scratchName} with (force)`);
    await admin.end();
  });

  async function applied(): Promise<number> {
    const { rows } = await scratch.query<{ count: string }>(
      "select count(*) from pgmigrations",
    );
    return Number(rows[0]!.count);
  }

  it("brings an empty database up to every migration", async () => {
    await migrateOnStart(scratch, { dir: migrationsDir, log: quiet });

    expect(await applied()).toBe(migrationCount);
  });

  it("finds nothing to do on a second start", async () => {
    await migrateOnStart(scratch, { dir: migrationsDir, log: quiet });
    await migrateOnStart(scratch, { dir: migrationsDir, log: quiet });

    expect(await applied()).toBe(migrationCount);
  });

  it("upgrades pre-initialization sessions and saves without inventing recorded input", async () => {
    const client = await scratch.connect();
    try {
      await runner({
        dbClient: client,
        dir: migrationsDir,
        direction: "up",
        count: 17,
        migrationsTable: "pgmigrations",
        log: quiet,
      });
    } finally {
      client.release();
    }
    expect(await applied()).toBe(17);
    const sessionId = randomUUID();
    const saveId = randomUUID();
    const blob = '{"campaignId":"test","status":"active","actionLog":[]}';
    await scratch.query(
      `insert into sessions (session_id, blob, audience, attempt_counter, replay_compatible,
        created_at, updated_at, campaign_id, status, step_count)
       values ($1, $2, 'player', 0, true, 'original-created', 'original-updated', 'test', 'active', 0)`,
      [sessionId, blob],
    );
    await scratch.query(
      `insert into saves (save_id, campaign_id, blob, saved_at_seq, audience, saved_at)
       values ($1, 'test', $2, 0, 'player', 'original-saved')`,
      [saveId, blob],
    );
    const sessionsBefore = (await scratch.query("select * from sessions")).rows;
    const savesBefore = (await scratch.query("select * from saves")).rows;

    // Run the real startup migration entry point over the already-populated schema.
    await migrateOnStart(scratch, { dir: migrationsDir, log: quiet });
    expect(await applied()).toBe(migrationCount);
    expect((await scratch.query("select * from sessions")).rows).toStrictEqual(
      sessionsBefore.map((row) => ({ ...row, initialization: null })),
    );
    expect((await scratch.query("select * from saves")).rows).toStrictEqual(
      savesBefore.map((row) => ({ ...row, initialization: null })),
    );
    const columns = await scratch.query(
      `select table_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name in ('sessions', 'saves')
         and column_name = 'initialization' order by table_name`,
    );
    expect(columns.rows).toStrictEqual(
      ["saves", "sessions"].map((table_name) => ({
        table_name,
        data_type: "jsonb",
        is_nullable: "YES",
        column_default: null,
      })),
    );
  });

  it("lets concurrent starts through one at a time, and every one succeeds", async () => {
    // Without the waiting lock, the second and third runs would either fail on
    // node-pg-migrate's try-lock or race the first to create the same tables.
    await Promise.all(
      [1, 2, 3].map(() =>
        migrateOnStart(scratch, { dir: migrationsDir, log: quiet }),
      ),
    );

    expect(await applied()).toBe(migrationCount);
  });

  it("waits while another holder has the lock, then proceeds", async () => {
    const holder = await scratch.connect();
    await holder.query("select pg_advisory_lock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);

    let finished = false;
    const run = migrateOnStart(scratch, {
      dir: migrationsDir,
      log: quiet,
    }).then(() => {
      finished = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);

    await holder.query("select pg_advisory_unlock($1::bigint)", [
      MIGRATION_LOCK_KEY,
    ]);
    holder.release();
    await run;

    expect(finished).toBe(true);
    expect(await applied()).toBe(migrationCount);
  });

  it("releases the lock when a run fails", async () => {
    await expect(
      migrateOnStart(scratch, {
        dir: join(migrationsDir, "does-not-exist"),
        log: quiet,
      }),
    ).rejects.toThrow();

    const { rows } = await scratch.query<{ obtained: boolean }>(
      "select pg_try_advisory_lock($1::bigint) as obtained",
      [MIGRATION_LOCK_KEY],
    );
    expect(rows[0]!.obtained).toBe(true);
  });
});
