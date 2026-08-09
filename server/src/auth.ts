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
      return;
    }
    const guest = await createPlayer(pool, "guest");
    await issueSession(pool, reply, guest.playerId);
    request.player = guest;
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
 * GitHub upgrade: converts the current guest in place if `githubId` is unclaimed (every
 * session/save the guest already owns keeps pointing at the same `player_id`, so there is
 * no data migration), or re-points the guest's sessions/saves onto the existing
 * GitHub-linked player and discards the now-empty guest row.
 */
export async function upgradeToGithub(
  pool: Pool,
  guestPlayerId: string,
  githubId: string,
  displayName: string | undefined,
): Promise<Player> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query(
      `select player_id, kind, display_name from players where github_id = $1`,
      [githubId],
    );

    let player: Player;
    if (existing.rows.length === 0) {
      const updated = await client.query(
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
      if (target !== guestPlayerId) {
        await client.query(
          `update sessions set profile_id = $1 where profile_id = $2`,
          [target, guestPlayerId],
        );
        await client.query(
          `update saves set profile_id = $1 where profile_id = $2`,
          [target, guestPlayerId],
        );
        await client.query(`delete from players where player_id = $1`, [
          guestPlayerId,
        ]);
      }
      player = {
        playerId: target,
        kind: "github",
        displayName: existing.rows[0].display_name,
      };
    }

    await client.query("commit");
    return player;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

declare module "fastify" {
  interface FastifyRequest {
    player: Player;
  }
}
