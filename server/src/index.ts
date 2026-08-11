import { Pool } from "pg";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";
const apiUrl = process.env.API_URL ?? "http://localhost:8787";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
// Unset means "read content from disk" -- `buildApp` defaults to `createDiskCampaignSource`
// (issue #27). Comma-separated `provider:subject` pairs gate `/api/admin/*`; unset means
// nobody passes the guard, not that the guard is skipped.
const contentBaseUrl = process.env.CONTENT_BASE_URL;
const adminSubjects = (process.env.ADMIN_SUBJECTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const pool = new Pool({ connectionString: databaseUrl });
const app = await buildApp(pool, {
  siteUrl,
  apiUrl,
  ...(contentBaseUrl ? { contentBaseUrl } : {}),
  adminSubjects,
});

await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
}
