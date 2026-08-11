import { Pool } from "pg";
import { buildApp } from "./app.js";
import { createDiskCampaignSource } from "./campaigns/source.js";
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
// `The-Running-Dev/SubZeroDev.Adventures.Content` does not exist yet as of this writing, so
// this source 404s on every load. Its `fallback` is what keeps that from making the whole
// server unpublishable: it degrades to the committed disk snapshot -- the same content this
// URL is meant to serve -- and the refresh goes through, so content an operator adds through
// the admin page actually goes live instead of being saved behind a source that cannot
// succeed. The failure is still reported, on the builtin's own row.
//
const campaignSource = createMultiSourceCampaignSource(pool, {
  id: "builtin-default",
  label: "SubZeroDev.Adventures.Content",
  kind: "url",
  url: "https://the-running-dev.github.io/SubZeroDev.Adventures.Content/",
  fallback: createDiskCampaignSource(),
});

const app = await buildApp(pool, {
  siteUrl,
  apiUrl,
  campaignSource,
  // Boots from the snapshot when the first build off `campaignSource` fails for any reason
  // -- including one that no source-level fallback can see, because it happens *after*
  // every source has loaded: a pasted extension that collides with the campaign it extends
  // fails validation of the merged registry, not a fetch. That is the failure that
  // crash-looped this server in production, and it is why this guard lives at the cell and
  // not on a source (`content-cell.ts`'s `ready`).
  bootstrapSource: createDiskCampaignSource(),
  adminSubjects,
});

await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
}
