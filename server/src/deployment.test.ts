/**
 * Guards the wiring issue #53 was about: the deployed process must hand `buildApp` a
 * bootstrap source, and that source must be able to produce a real, playable catalog.
 *
 * Both halves matter and neither implies the other. `app.ts` and `content-cell.ts` both
 * documented a snapshot fallback that `index.ts` had simply never passed, so a single
 * unbuildable campaign in the published content aborted the boot before the port was bound
 * -- with the admin API that could have removed it never coming up. A `bootstrapSource`
 * that is merely *present* but points at content the image does not carry would fail the
 * same way, one line later, so this loads it and builds a catalog out of it for real.
 *
 * No `DATABASE_URL` needed: nothing here queries Postgres. `routes/admin.test.ts`'s
 * "boots on the snapshot" case covers the end-to-end recovery against a live database.
 */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { buildCatalog } from "../../shared/campaign-registry.js";
import {
  createBootstrapCampaignSource,
  DEFAULT_SESSION_CACHE_LIMIT,
  deploymentConfig,
  parseBackupRetentionDays,
  parseSessionCacheLimit,
} from "./deployment.js";

// `createMultiSourceCampaignSource` only stores the pool for a later query; nothing in
// `deploymentConfig` touches it, and asserting on the config must not need a database.
const noPool = {} as Pool;

describe("deploymentConfig", () => {
  it("passes a bootstrap source, so unbuildable published content cannot brick the boot", () => {
    const config = deploymentConfig(noPool, {
      siteUrl: "https://example.invalid",
      apiUrl: "https://api.example.invalid",
      previewOrigins: [],
      discussionForum: undefined,
      sessionCacheLimit: DEFAULT_SESSION_CACHE_LIMIT,
      backupRetentionDays: 7,
      ledgerDatabaseUrl: undefined,
    });

    expect(config.bootstrapSource).toBeDefined();
    expect(config.campaignSource).toBeDefined();
  });

  it("passes the session cache limit through, so the deployed store is bounded", () => {
    const config = deploymentConfig(noPool, {
      siteUrl: "https://example.invalid",
      apiUrl: "https://api.example.invalid",
      previewOrigins: [],
      discussionForum: undefined,
      sessionCacheLimit: 250,
      backupRetentionDays: 7,
      ledgerDatabaseUrl: undefined,
    });

    expect(config.sessionCacheLimit).toBe(250);
  });

  it("always passes a ledger and the backup retention, so neither falls to a test default", async () => {
    const config = deploymentConfig(noPool, {
      siteUrl: "https://example.invalid",
      apiUrl: "https://api.example.invalid",
      previewOrigins: [],
      discussionForum: undefined,
      sessionCacheLimit: DEFAULT_SESSION_CACHE_LIMIT,
      backupRetentionDays: 14,
      ledgerDatabaseUrl: undefined,
    });

    expect(config.backupRetentionDays).toBe(14);
    // Unset is a ledger that cannot be reached -- never the in-memory one `buildApp`
    // defaults to, which a restart would empty.
    await expect(config.ledger!.since(0)).rejects.toThrow();
  });
});

describe("parseBackupRetentionDays", () => {
  it("accepts a whole number of days up to 30", () => {
    expect(parseBackupRetentionDays("0")).toBe(0);
    expect(parseBackupRetentionDays(" 7 ")).toBe(7);
    expect(parseBackupRetentionDays("30")).toBe(30);
  });

  it.each([undefined, "", "  ", "-1", "1.5", "7d", "abc", "1e1"])(
    "refuses %s at startup",
    (raw) => {
      expect(() => parseBackupRetentionDays(raw)).toThrow(
        /BACKUP_RETENTION_DAYS must be a whole number/,
      );
    },
  );

  it("refuses more than 30, the supported maximum", () => {
    expect(() => parseBackupRetentionDays("31")).toThrow(/at most 30/);
    expect(() => parseBackupRetentionDays("365")).toThrow(/at most 30/);
  });
});

describe("parseSessionCacheLimit", () => {
  it("defaults when unset or blank", () => {
    expect(parseSessionCacheLimit(undefined)).toBe(DEFAULT_SESSION_CACHE_LIMIT);
    expect(parseSessionCacheLimit("")).toBe(DEFAULT_SESSION_CACHE_LIMIT);
    expect(parseSessionCacheLimit("  ")).toBe(DEFAULT_SESSION_CACHE_LIMIT);
  });

  it("accepts a positive whole number", () => {
    expect(parseSessionCacheLimit("1")).toBe(1);
    expect(parseSessionCacheLimit(" 250 ")).toBe(250);
  });

  it.each(["0", "-1", "1.5", "1e3", "abc", "0x10", "9007199254740992"])(
    "refuses %s at startup",
    (raw) => {
      expect(() => parseSessionCacheLimit(raw)).toThrow(/SESSION_CACHE_LIMIT/);
    },
  );
});

describe("createBootstrapCampaignSource", () => {
  it("loads the committed snapshot and it builds a valid catalog", async () => {
    const { campaigns, extensions } =
      await createBootstrapCampaignSource().load();

    expect(campaigns.length).toBeGreaterThan(0);
    const catalog = buildCatalog(campaigns, extensions);
    expect(catalog.all.length).toBe(campaigns.length);
  });
});
