import { Pool } from "pg";
import { buildApp } from "./app.js";
import { deploymentConfig } from "./deployment.js";
import { loadDiscussionForum } from "./discussions/registry.js";

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
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });

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
  }),
);

await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
}
