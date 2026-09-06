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
  deploymentConfig,
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
    });

    expect(config.bootstrapSource).toBeDefined();
    expect(config.campaignSource).toBeDefined();
  });
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
