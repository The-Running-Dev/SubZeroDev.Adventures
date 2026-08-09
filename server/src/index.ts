import { Pool } from "pg";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 8787);
const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });
const app = await buildApp(pool, siteUrl);

await app.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end());
  });
}
