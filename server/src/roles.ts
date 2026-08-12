/**
 * `players.role` (migration 012) -- replaces the `ADMIN_SUBJECTS` env allowlist
 * `routes/admin.ts` used to check. A role is queryable and grantable at runtime instead of
 * fixed at deploy time; the first grant still has to come from somewhere outside the API
 * itself, since nobody can be an admin yet to grant the first one -- see `grant-role-cli.ts`.
 */
import type { Pool } from "pg";

export type Role = "player" | "admin";

export async function roleOf(pool: Pool, playerId: string): Promise<Role> {
  const { rows } = await pool.query<{ role: Role }>(
    `select role from players where player_id = $1`,
    [playerId],
  );
  return rows[0]?.role ?? "player";
}

export async function isAdmin(pool: Pool, playerId: string): Promise<boolean> {
  return (await roleOf(pool, playerId)) === "admin";
}

/** `true` if a row was actually updated -- lets a caller tell "granted" from "no such
 *  player" the same way `content-sources.ts`'s `removeContentSource` does. */
export async function setRole(
  pool: Pool,
  playerId: string,
  role: Role,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update players set role = $2 where player_id = $1`,
    [playerId, role],
  );
  return (rowCount ?? 0) > 0;
}

/** Resolves a `(provider, subject)` pair (as configured for `ADMIN_SUBJECTS`, or typed by an
 *  operator into `grant-role-cli.ts`) to the player it's linked to, if any -- the one place
 *  outside `principal.ts` that reads `identities` this way, kept here rather than duplicated
 *  in both callers. */
export async function findPlayerByIdentity(
  pool: Pool,
  provider: string,
  subject: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ player_id: string }>(
    `select player_id from identities where provider = $1 and subject = $2`,
    [provider, subject],
  );
  return rows[0]?.player_id;
}
