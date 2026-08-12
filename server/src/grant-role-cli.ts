/**
 * Grants a role to a player by their linked `(provider, subject)` identity -- the one-off,
 * once-per-deployment step that replaces setting `ADMIN_SUBJECTS` (see `roles.ts`, migration
 * 012). Not part of `docker-entrypoint.sh`'s `serve`/`migrate` vocabulary: an operator runs
 * this by hand, against the deployed database, the same way they'd have edited the env
 * allowlist before. The target player must already exist (have signed in at least once) --
 * this does not mint one, matching `resolveAdmin`'s "never mint a guest" posture elsewhere.
 *
 *   node dist/server/src/grant-role-cli.js <provider> <subject> [role]
 *
 * `role` defaults to "admin"; pass "player" to revoke.
 */
import { Pool } from "pg";
import { findPlayerByIdentity, setRole, type Role } from "./roles.js";

const [provider, subject, roleArg] = process.argv.slice(2);
if (!provider || !subject) {
  console.error(
    "usage: grant-role-cli.ts <provider> <subject> [role=admin|player]",
  );
  process.exit(1);
}
const role: Role = roleArg === "player" ? "player" : "admin";
if (roleArg !== undefined && roleArg !== "admin" && roleArg !== "player") {
  console.error(`unknown role "${roleArg}" -- expected "admin" or "player"`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl });

const playerId = await findPlayerByIdentity(pool, provider, subject);
if (!playerId) {
  console.error(
    `no player is linked to ${provider}:${subject} -- they need to sign in at least once first`,
  );
  await pool.end();
  process.exit(1);
}
await setRole(pool, playerId, role);
console.log(
  `granted role "${role}" to player ${playerId} (${provider}:${subject})`,
);
await pool.end();
