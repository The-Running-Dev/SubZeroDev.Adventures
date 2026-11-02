/**
 * Entry point for the `migrate` case of docker-entrypoint.sh -- run once per deploy, after
 * schema migrations, by the same one-shot container (the dev stack; the deployment stack
 * sweeps from `index.ts` under `MIGRATE_ON_START=true` instead). Not a long-running process: connects,
 * sweeps, exits.
 */
import { Pool } from "pg";
import { sweepExpiredCaptures, sweepExpiredSessions } from "./maintenance.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl });
const swept = await sweepExpiredSessions(pool);
console.log(`maintenance: swept ${swept} expired auth session(s)`);
const captures = await sweepExpiredCaptures(pool);
console.log(`maintenance: swept ${captures} expired session capture(s)`);
await pool.end();
