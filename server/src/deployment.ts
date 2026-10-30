/**
 * What the *deployed* process wires up, separated from `index.ts` so it can be asserted in
 * a test without booting a server or holding a database.
 *
 * `index.ts` stays the only reader of `process.env` (issue #12): the values below arrive as
 * parameters, and nothing here consults the environment. What it owns instead is the pair of
 * content sources that are properties of the deployment rather than of the environment --
 * the hardcoded published source, and the snapshot the server falls back to when that source
 * cannot be built. Both used to live inline in `index.ts`, where "does the deployed server
 * actually pass a bootstrap source?" was a question only a human reading the file could
 * answer -- and for a while the answer was no while two comments elsewhere said yes
 * (issue #53).
 */
import type { Pool } from "pg";
import type { AppConfig } from "./app.js";
import { createMultiSourceCampaignSource } from "./campaigns/multi-source.js";
import { createDiskCampaignSource } from "./campaigns/source.js";
import type { CampaignSource } from "./campaigns/source.js";
import type { DiscussionForum } from "./discussions/forum.js";
import {
  createPostgresLedger,
  createUnreachableLedger,
} from "./content/ledger.js";

/**
 * The one hardcoded, unremovable content source (issue #27) -- always prepended ahead of
 * whatever an admin has added through `/api/admin/content/sources` (content-sources.ts).
 * It is not admin-editable and carries no `CAMPAIGNS_DIR`/env override: the way to point a
 * deployment somewhere else is to add another source, not to change this one.
 *
 * `The-Running-Dev/SubZeroDev.Adventures.Content` serves its manifest at the repo root, not
 * under a `v2/` path -- an earlier commit here guessed `v2/` before the site had actually
 * finished publishing and got it wrong; verified live against the deployed Pages site before
 * fixing this.
 */
export function createPublishedCampaignSource(pool: Pool): CampaignSource {
  return createMultiSourceCampaignSource(pool, {
    id: "builtin-default",
    label: "SubZeroDev.Adventures.Content",
    kind: "url",
    url: "https://the-running-dev.github.io/SubZeroDev.Adventures.Content/",
  });
}

/**
 * The snapshot a deployment boots from when the *first* build off the published source
 * fails -- `content-cell.ts`'s `ready`, and `app.ts`'s `bootstrapSource`.
 *
 * It reads `public/campaigns/`, the committed fixture set, which `server/Dockerfile` copies
 * into the image and points `CAMPAIGNS_DIR` at. That is a deliberate change of posture:
 * before issue #53 the image carried no content at all, on the reasoning that the deployed
 * server has no disk content source and fixtures in a production image are a liability. The
 * counterweight is that a single unbuildable campaign -- one string-key collision in the
 * published content was enough -- aborted the boot, the process exited before binding a
 * port, and the admin API that could have removed the offending source was the thing that
 * never came up. A snapshot that is merely *stale* is recoverable from the running admin
 * page; a server that will not start is recoverable only through psql.
 *
 * Nothing hides that the snapshot is being served: `ContentStatus.bootstrapFallback` stays
 * true and `lastError` keeps the real reason until a refresh succeeds.
 */
export function createBootstrapCampaignSource(): CampaignSource {
  return createDiskCampaignSource();
}

/**
 * What a deployment holds in memory when `SESSION_CACHE_LIMIT` is unset. Provisional: no
 * deployment has measured it. Sized against the counters the admin status page now reports --
 * `sessionCache.readBlobBytes.max` times this is the worst case the cache can reach, and a
 * `cacheMisses` count climbing under steady play means it is too small.
 */
export const DEFAULT_SESSION_CACHE_LIMIT = 1000;

/**
 * `SESSION_CACHE_LIMIT` as `index.ts` read it. Unset or blank is the default; anything else
 * must be a positive whole number, and is otherwise a startup failure rather than a silent
 * fallback -- an operator who set `SESSION_CACHE_LIMIT=1e3` or `=0` meant something, and
 * serving with a bound they did not choose is worse than not starting. The engine refuses a
 * non-positive or unsafe integer on its own (`createInMemorySessionStore` throws a
 * `RangeError`), but only once the first build runs, and with a message that names its
 * option rather than this variable.
 */
export function parseSessionCacheLimit(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  if (value === "") return DEFAULT_SESSION_CACHE_LIMIT;
  const limit = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(
      `SESSION_CACHE_LIMIT must be a positive whole number, got "${raw}"`,
    );
  return limit;
}

/** The supported maximum for `BACKUP_RETENTION_DAYS` (engine plan 54, D3 §7). */
export const MAX_BACKUP_RETENTION_DAYS = 30;

/**
 * `BACKUP_RETENTION_DAYS` as `index.ts` read it: how many days the operator attests a backup of
 * this deployment's database survives. A deletion purges every active copy at once; a backup
 * copy expires only with the backup, so the confirmation states this number and the host
 * cannot honestly start without one. Unlike `SESSION_CACHE_LIMIT` there is no default -- the
 * host cannot inspect a provider's backups, so the value is the operator's to state -- and
 * above 30 is unsupported, so it is refused rather than reported.
 */
export function parseBackupRetentionDays(raw: string | undefined): number {
  const value = raw?.trim() ?? "";
  const days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(days))
    throw new Error(
      `BACKUP_RETENTION_DAYS must be a whole number of days, got ${raw === undefined ? "nothing" : `"${raw}"`}`,
    );
  if (days > MAX_BACKUP_RETENTION_DAYS)
    throw new Error(
      `BACKUP_RETENTION_DAYS must be at most ${MAX_BACKUP_RETENTION_DAYS}, got ${days}: longer backup retention is unsupported`,
    );
  return days;
}

/** The full `AppConfig` the deployed process hands `buildApp`. `env` is what `index.ts`
 *  read out of the environment; everything else is a property of the deployment. */
export function deploymentConfig(
  pool: Pool,
  env: {
    readonly siteUrl: string;
    readonly apiUrl: string;
    readonly previewOrigins: readonly string[];
    readonly discussionForum: DiscussionForum | undefined;
    readonly sessionCacheLimit: number;
    readonly backupRetentionDays: number;
    /** `LEDGER_DATABASE_URL`. Unset is a ledger that cannot be reached: every reconcile fails,
     *  so the server serves core content and withholds everything else (D3 §5.3) -- the
     *  deployed process never runs on a ledger that a database restore would roll back. */
    readonly ledgerDatabaseUrl: string | undefined;
  },
): AppConfig {
  return {
    siteUrl: env.siteUrl,
    apiUrl: env.apiUrl,
    previewOrigins: env.previewOrigins,
    campaignSource: createPublishedCampaignSource(pool),
    bootstrapSource: createBootstrapCampaignSource(),
    discussionForum: env.discussionForum,
    sessionCacheLimit: env.sessionCacheLimit,
    backupRetentionDays: env.backupRetentionDays,
    ledger:
      env.ledgerDatabaseUrl === undefined || env.ledgerDatabaseUrl === ""
        ? createUnreachableLedger()
        : createPostgresLedger(env.ledgerDatabaseUrl),
  };
}
