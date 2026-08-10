/**
 * Entry point for the `migrate` case of docker-entrypoint.sh -- run once per deploy, after
 * schema migrations, by the same one-shot container. Not a long-running process: connects,
 * sweeps, exits.
 */
import { Pool } from "pg";
import { sweepExpiredSessions } from "./maintenance.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });
const swept = await sweepExpiredSessions(pool);
console.log(`maintenance: swept ${swept} expired auth session(s)`);
await pool.end();
