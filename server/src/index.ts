import { Pool } from "pg";
import { buildApp } from "./app.js";
import { createDiskCampaignSource } from "./campaigns/source.js";
import {
  createMultiSourceCampaignSource,
  withBootstrapFallback,
} from "./campaigns/multi-source.js";

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
// `The-Running-Dev/SubZeroDev.Adventures.Content` does not exist yet as of this writing --
// every *refresh* fails-closed and reports that until it does, same as any other broken
// source; `withBootstrapFallback` (multi-source.ts) is only what keeps that from also
// blocking the very first boot, by falling back to the committed disk snapshot exactly
// once, on the first `load()`, if the real source fails.
const campaignSource = withBootstrapFallback(
  createMultiSourceCampaignSource(pool, {
    id: "builtin-default",
    label: "SubZeroDev.Adventures.Content",
    kind: "url",
    url: "https://the-running-dev.github.io/SubZeroDev.Adventures.Content/",
  }),
  createDiskCampaignSource(),
);

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
