import { Pool } from "pg";
import { buildApp } from "./app.js";
import { createMultiSourceCampaignSource } from "./campaigns/multi-source.js";

const port = Number(process.env.PORT ?? 8787);
const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";
const apiUrl = process.env.API_URL ?? "http://localhost:8787";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
// Comma-separated `provider:subject` pairs gate `/api/admin/*`; unset means nobody passes
// the guard, not that the guard is skipped.
const adminSubjects = (process.env.ADMIN_SUBJECTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const pool = new Pool({ connectionString: databaseUrl });

// The one hardcoded, unremovable content source (issue #27) -- always prepended ahead of
// whatever an admin has added through `/api/admin/content/sources` (content-sources.ts).
// It is not admin-editable and carries no `CAMPAIGNS_DIR`/env override: the way to point a
// deployment somewhere else is to add another source, not to change this one.
//
// `The-Running-Dev/SubZeroDev.Adventures.Content` serves its manifest at the repo root, not
// under a `v2/` path -- an earlier commit here guessed `v2/` before the site had actually
// finished publishing and got it wrong; verified live against the deployed Pages site before
// fixing this. It is the one source of truth for campaign content now -- no disk fallback
// stands behind it. `public/campaigns/` still exists in this repository, but only as a
// fixture set the test suite imports directly; it is not wired into any runtime path, so it
// cannot drift from what actually ships without a test catching it, and it also cannot
// silently paper over this source being unreachable.
const campaignSource = createMultiSourceCampaignSource(pool, {
  id: "builtin-default",
  label: "SubZeroDev.Adventures.Content",
  kind: "url",
  url: "https://the-running-dev.github.io/SubZeroDev.Adventures.Content/",
});

const app = await buildApp(pool, {
  siteUrl,
  apiUrl,
  campaignSource,
  adminSubjects,
});

await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
}
