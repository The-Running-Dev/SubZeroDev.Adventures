import { Pool } from "pg";
import { buildApp } from "./app.js";
import {
  deploymentConfig,
  parseBackupRetentionDays,
  parseSessionCacheLimit,
} from "./deployment.js";
import { loadDiscussionForum } from "./discussions/registry.js";
import { migrateOnStart } from "./migrate-on-start.js";
import { sweepExpiredSessions } from "./maintenance.js";

const port = Number(process.env.PORT ?? 8787);
const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";
const apiUrl = process.env.API_URL ?? "http://localhost:8787";
// Comma-separated extra browser origins allowed to call this API (`app.ts`'s
// `AppConfig.previewOrigins`) -- the tunnelled preview host in docs/preview.md is why this
// exists. Unset means "SITE_URL and nothing else", which is the posture every deployment
// had before it. Parsed here rather than in `app.ts` because `index.ts` is the one place
// this server reads `process.env` (issue #12).
const previewOrigins = (process.env.PREVIEW_ORIGINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");
// How many sessions the engine store keeps in memory before evicting the least recently used
// (`deployment.ts`'s `parseSessionCacheLimit`). Read before anything connects, so a malformed
// value fails the start rather than the first content build.
const sessionCacheLimit = parseSessionCacheLimit(
  process.env.SESSION_CACHE_LIMIT,
);
// The operator's attested backup retention (`deployment.ts`'s `parseBackupRetentionDays`),
// which a deletion's confirmation states. Required, and at most 30: read before anything
// connects, so a deployment without one never starts.
const backupRetentionDays = parseBackupRetentionDays(
  process.env.BACKUP_RETENTION_DAYS,
);
// The external deletion ledger, a database a restore of DATABASE_URL does not roll back
// (`content/ledger.ts`). Unset serves core content only.
const ledgerDatabaseUrl = process.env.LEDGER_DATABASE_URL;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });

// Off unless asked for. The deployment stack sets it; the dev stack still migrates through
// its one-shot `migrate` container. `true` brings the schema up here, under an advisory
// lock, before anything binds a port (migrate-on-start.ts). `migrations` is relative to the
// working directory, the same as the CLI's default.
//
// The deterministic upkeep that the one-shot container ran after `node-pg-migrate up`
// (issue #12) runs here too, once per start and after the migrations, so retiring that
// container does not retire the sweep. Like the container, a failure stops the start.
if (process.env.MIGRATE_ON_START === "true") {
  await migrateOnStart(pool, { dir: "migrations" });
  const swept = await sweepExpiredSessions(pool);
  console.log(`maintenance: swept ${swept} expired auth session(s)`);
}

// Reads DISCUSSIONS_REPO/DISCUSSIONS_TOKEN/DISCUSSIONS_CATEGORY -- unset (any of the
// three) means the feature is off, not a startup failure (discussions/registry.ts).
const discussionForum = loadDiscussionForum();

// Which content sources a deployment runs on -- including the bootstrap snapshot that keeps
// unbuildable content from bricking the boot -- lives in `deployment.ts`, where a test can
// assert it. This file's job is the environment and the socket.
const app = await buildApp(
  pool,
  deploymentConfig(pool, {
    siteUrl,
    apiUrl,
    previewOrigins,
    discussionForum,
    sessionCacheLimit,
    backupRetentionDays,
    ledgerDatabaseUrl,
  }),
);

await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
}
