/**
 * The principal-resolution seam: the one module that answers "who is this request?".
 * Nothing else reaches around it -- routes and the store decorator (`store/ownedStore.ts`)
 * only ever learn the caller's identity through `resolvePrincipal` / `requirePrincipal`.
 *
 * Guest-first, unchanged from the prior implementation: any request without a valid
 * session cookie is minted a guest `players` row and an `auth_sessions` row on first
 * contact -- nobody hits a login wall before playing. The cookie carries an opaque token;
 * only its sha256 is ever persisted, so a leaked database row cannot be replayed as a
 * cookie.
 *
 * What changed from the old `auth.ts`: `upgradeToGithub` generalizes to
 * `upgradeViaIdentity`, keyed by `(provider, subject)` against the `identities` table
 * (migration 007) instead of a single `github_id` column -- GitHub is now one provider
 * among however many `identity/registry.ts` configures, not a hardcoded second `kind`.
 */
import { randomUUID, createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export const SESSION_COOKIE = "sza_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

export interface Principal {
  playerId: string;
  /** 'member' replaces the old 'github' -- a player who has linked any identity, not
   *  specifically a GitHub one (migration 007). */
  kind: "guest" | "member";
  displayName: string | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintToken(): string {
  return randomBytes(32).toString("hex");
}

function toPrincipal(row: {
  player_id: string;
  kind: string;
  display_name: string | null;
}): Principal {
  return {
    playerId: row.player_id,
    kind: row.kind as Principal["kind"],
    displayName: row.display_name,
  };
}

async function createGuest(pool: Pool): Promise<Principal> {
  const playerId = randomUUID();
  const { rows } = await pool.query(
    `insert into players (player_id, kind) values ($1, 'guest')
     returning player_id, kind, display_name`,
    [playerId],
  );
  return toPrincipal(rows[0]);
}

async function issueSession(
  pool: Pool,
  reply: FastifyReply,
  playerId: string,
): Promise<void> {
  const token = mintToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `insert into auth_sessions (token_hash, player_id, expires_at) values ($1, $2, $3)`,
    [hashToken(token), playerId, expiresAt],
  );
  // Expired rows are otherwise only ever filtered, never deleted -- swept deterministically
  // by `maintenance.ts`, run once per deploy from the one-shot migrate container
  // (docker-entrypoint.sh), not by chance here on the hot path of every session mint.
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

async function lookupPrincipal(
  pool: Pool,
  token: string,
): Promise<Principal | undefined> {
  const { rows } = await pool.query(
    `select p.player_id, p.kind, p.display_name
     from auth_sessions a
     join players p on p.player_id = a.player_id
     where a.token_hash = $1 and a.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ? toPrincipal(rows[0]) : undefined;
}

async function principalById(pool: Pool, playerId: string): Promise<Principal> {
  const { rows } = await pool.query(
    `select player_id, kind, display_name from players where player_id = $1`,
    [playerId],
  );
  return toPrincipal(rows[0]);
}

/** Resolves the current principal, minting a guest identity on first contact. Attach as a
 *  Fastify `preHandler` ahead of any route that needs `request.principal`. */
export function requirePrincipal(pool: Pool) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    const existing = token ? await lookupPrincipal(pool, token) : undefined;
    if (existing) {
      request.principal = existing;
      request.principalOrNull = existing;
      return;
    }
    const guest = await createGuest(pool);
    await issueSession(pool, reply, guest.playerId);
    request.principal = guest;
    request.principalOrNull = guest;
  };
}

/**
 * Read-only counterpart to `requirePrincipal`: resolves an existing session cookie but
 * never mints a guest row. A cookieless or expired request is simply anonymous here.
 * Attach to any route that only needs to know *whether* there's a principal, not to have
 * one -- an unauthenticated crawler hitting a read endpoint should not grow the `players`
 * table.
 */
export function resolvePrincipal(pool: Pool) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    request.principalOrNull = token
      ? await lookupPrincipal(pool, token)
      : undefined;
  };
}

export async function logout(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token)
    await pool.query(`delete from auth_sessions where token_hash = $1`, [
      hashToken(token),
    ]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Re-points every session/save owned by `fromPlayerId` onto `toPlayerId` and deletes the
 * now-empty `fromPlayerId` row, in one transaction. Shared by `upgradeViaIdentity` below
 * and transfer-code redemption (`routes/transfer.ts`) -- both are "fold one player's
 * history into another's" operations, differing only in how the target player is
 * identified. No-ops (does not delete `fromPlayerId`) when the two ids are already equal.
 */
export async function mergePlayers(
  pool: Pool,
  fromPlayerId: string,
  toPlayerId: string,
): Promise<void> {
  if (fromPlayerId === toPlayerId) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update sessions set profile_id = $1 where profile_id = $2`,
      [toPlayerId, fromPlayerId],
    );
    await client.query(
      `update saves set profile_id = $1 where profile_id = $2`,
      [toPlayerId, fromPlayerId],
    );
    await client.query(`delete from players where player_id = $1`, [
      fromPlayerId,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Rotates the session cookie: deletes the old `auth_sessions` row and issues a fresh
 * token bound to `playerId`. Called at every privilege boundary (identity upgrade,
 * transfer redemption) so a token minted for a guest can't go on authenticating a
 * now-upgraded account -- textbook session-fixation hygiene, cheap because
 * `auth_sessions` is token-keyed already.
 */
export async function rotateSession(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  playerId: string,
): Promise<void> {
  const oldToken = request.cookies[SESSION_COOKIE];
  if (oldToken)
    await pool.query(`delete from auth_sessions where token_hash = $1`, [
      hashToken(oldToken),
    ]);
  await issueSession(pool, reply, playerId);
}

/**
 * Identity upgrade: links `(provider, subject)` to the current guest in place if
 * unclaimed (every session/save the guest already owns keeps pointing at the same
 * `player_id`, so there is no data migration), or merges the guest's history onto the
 * existing linked player via `mergePlayers` and discards the now-empty guest row.
 * Rotates the session token either way -- see `rotateSession`. Replaces the old
 * GitHub-specific `upgradeToGithub`; GitHub is just the `provider` value "github" here.
 */
export async function upgradeViaIdentity(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  guestPlayerId: string,
  provider: string,
  subject: string,
  displayName: string | undefined,
): Promise<Principal> {
  const existing = await pool.query(
    `select player_id from identities where provider = $1 and subject = $2`,
    [provider, subject],
  );

  let playerId: string;
  if (existing.rows.length === 0) {
    await pool.query(
      `insert into identities (provider, subject, player_id) values ($1, $2, $3)`,
      [provider, subject, guestPlayerId],
    );
    await pool.query(
      `update players set kind = 'member', display_name = coalesce($2, display_name)
       where player_id = $1`,
      [guestPlayerId, displayName ?? null],
    );
    playerId = guestPlayerId;
  } else {
    playerId = existing.rows[0].player_id as string;
    await mergePlayers(pool, guestPlayerId, playerId);
    if (displayName) {
      await pool.query(
        `update players set display_name = coalesce(display_name, $2) where player_id = $1`,
        [playerId, displayName],
      );
    }
  }

  await rotateSession(pool, request, reply, playerId);
  return principalById(pool, playerId);
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    /** Set by both `requirePrincipal` and `resolvePrincipal` -- the latter leaves it
     *  `undefined` rather than minting. Routes that must not create a `players` row on a
     *  bare read (`/api/me`, `/api/saves`, `/api/progress`) use this instead of
     *  `principal`. */
    principalOrNull: Principal | undefined;
  }
}
