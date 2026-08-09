/**
 * Identity: guest-first, optional GitHub upgrade.
 *
 * Any request without a valid session cookie is minted a guest `players` row and an
 * `auth_sessions` row on first contact -- nobody hits a login wall before playing. The
 * cookie carries an opaque token; only its sha256 is ever persisted, so a leaked database
 * row cannot be replayed as a cookie.
 */
import { randomUUID, createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export const SESSION_COOKIE = "sza_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

export interface Player {
  playerId: string;
  kind: "guest" | "github";
  displayName: string | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintToken(): string {
  return randomBytes(32).toString("hex");
}

async function createPlayer(
  pool: Pool,
  kind: "guest" | "github",
  extra: { githubId?: string; displayName?: string } = {},
): Promise<Player> {
  const playerId = randomUUID();
  const { rows } = await pool.query(
    `insert into players (player_id, kind, github_id, display_name)
     values ($1, $2, $3, $4)
     returning player_id, kind, display_name`,
    [playerId, kind, extra.githubId ?? null, extra.displayName ?? null],
  );
  return {
    playerId: rows[0].player_id,
    kind: rows[0].kind,
    displayName: rows[0].display_name,
  };
}

// Expired auth_sessions rows are otherwise only ever filtered, never deleted -- there is
// no cron in this deployment to do it separately. Sweeping on ~1% of issues bounds the
// table's growth without adding a delete to the hot path of every session mint.
const SWEEP_SAMPLE_RATE = 0.01;

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
  if (Math.random() < SWEEP_SAMPLE_RATE) {
    await pool.query(`delete from auth_sessions where expires_at <= now()`);
  }
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

async function lookupPlayer(
  pool: Pool,
  token: string,
): Promise<Player | undefined> {
  const { rows } = await pool.query(
    `select p.player_id, p.kind, p.display_name
     from auth_sessions a
     join players p on p.player_id = a.player_id
     where a.token_hash = $1 and a.expires_at > now()`,
    [hashToken(token)],
  );
  if (!rows[0]) return undefined;
  return {
    playerId: rows[0].player_id,
    kind: rows[0].kind,
    displayName: rows[0].display_name,
  };
}

/** Resolves the current player, minting a guest identity on first contact. Attach as a
 *  Fastify `preHandler` ahead of any route that needs `request.player`. */
export function requirePlayer(pool: Pool) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    const existing = token ? await lookupPlayer(pool, token) : undefined;
    if (existing) {
      request.player = existing;
      request.playerOrNull = existing;
      return;
    }
    const guest = await createPlayer(pool, "guest");
    await issueSession(pool, reply, guest.playerId);
    request.player = guest;
    request.playerOrNull = guest;
  };
}

/**
 * Read-only counterpart to `requirePlayer`: resolves an existing session cookie but never
 * mints a guest row. A cookieless or expired request is simply anonymous here. Attach to
 * any route that only needs to know *whether* there's a player, not to have one -- an
 * unauthenticated crawler hitting `/api/me` or `/api/saves` should not grow the `players`
 * table.
 */
export function resolvePlayer(pool: Pool) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    request.playerOrNull = token ? await lookupPlayer(pool, token) : undefined;
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
 * now-empty `fromPlayerId` row, in one transaction. Shared by the GitHub upgrade below and
 * transfer-code redemption (`routes/transfer.ts`) -- both are "fold one player's history
 * into another's" operations, differing only in how the target player is identified.
 * No-ops (does not delete `fromPlayerId`) when the two ids are already equal.
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
 * token bound to `playerId`. Called at every privilege boundary (GitHub upgrade, transfer
 * redemption) so a token minted for a guest can't go on authenticating a now-upgraded
 * account -- textbook session-fixation hygiene, cheap because `auth_sessions` is
 * token-keyed already.
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
 * GitHub upgrade: converts the current guest in place if `githubId` is unclaimed (every
 * session/save the guest already owns keeps pointing at the same `player_id`, so there is
 * no data migration), or merges the guest's history onto the existing GitHub-linked player
 * via `mergePlayers` and discards the now-empty guest row. Rotates the session token
 * either way -- see `rotateSession`.
 */
export async function upgradeToGithub(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  guestPlayerId: string,
  githubId: string,
  displayName: string | undefined,
): Promise<Player> {
  const existing = await pool.query(
    `select player_id, kind, display_name from players where github_id = $1`,
    [githubId],
  );

  let player: Player;
  if (existing.rows.length === 0) {
    const updated = await pool.query(
      `update players set kind = 'github', github_id = $2, display_name = coalesce($3, display_name)
       where player_id = $1
       returning player_id, kind, display_name`,
      [guestPlayerId, githubId, displayName ?? null],
    );
    player = {
      playerId: updated.rows[0].player_id,
      kind: updated.rows[0].kind,
      displayName: updated.rows[0].display_name,
    };
  } else {
    const target = existing.rows[0].player_id as string;
    await mergePlayers(pool, guestPlayerId, target);
    player = {
      playerId: target,
      kind: "github",
      displayName: existing.rows[0].display_name,
    };
  }

  await rotateSession(pool, request, reply, player.playerId);
  return player;
}

declare module "fastify" {
  interface FastifyRequest {
    player: Player;
    /** Set by both `requirePlayer` and `resolvePlayer` -- the latter leaves it `undefined`
     *  rather than minting. Routes that must not create a `players` row on a bare read
     *  (`/api/me`, `/api/saves`, `/api/progress`) use this instead of `player`. */
    playerOrNull: Player | undefined;
  }
}
