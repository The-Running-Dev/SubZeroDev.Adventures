/**
 * Guest -> guest progress transfer, no third party involved: the device with progress
 * mints a short-lived one-time code, and a second device redeems it to fold that
 * progress onto its own identity. The identity upgrade (`principal.ts`) solves cross-device
 * for anyone willing to sign in; this solves it for anyone who isn't, at the cost of a
 * weaker recovery story -- lose the code, lose the transfer, same tradeoff as the upgrade
 * account-abandonment risk it doesn't touch.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { mergePlayers, rotateSession, requirePrincipal } from "../principal.js";

const CODE_TTL_MS = 1000 * 60 * 15; // 15 minutes
// Crockford base32 -- excludes I, L, O, U so a misread character never collides with
// another valid one.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** 5 random bytes -> 40 bits -> eight 5-bit groups, formatted `XXXX-XXXX`. */
function mintCode(): string {
  const bytes = randomBytes(5);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let code = "";
  for (let i = 0; i < 40; i += 5) {
    code += CODE_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
}

// Process-local, best-effort: bounds brute-force attempts against an 8-character code
// without adding a rate-limit dependency or shared store. Resets on restart and doesn't
// coordinate across replicas -- acceptable for this deployment's single instance, not a
// substitute for a real rate limiter if this ever scales out.
const REDEEM_WINDOW_MS = 1000 * 60 * 10;
const REDEEM_MAX_ATTEMPTS = 20;
const redeemAttempts = new Map<
  string,
  { count: number; windowStart: number }
>();

function redeemAllowed(ip: string): boolean {
  const now = Date.now();
  const entry = redeemAttempts.get(ip);
  if (!entry || now - entry.windowStart > REDEEM_WINDOW_MS) {
    redeemAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= REDEEM_MAX_ATTEMPTS;
}

export function registerTransferRoutes(app: FastifyInstance, pool: Pool): void {
  const auth = requirePrincipal(pool);

  app.post("/api/transfer/create", { preHandler: auth }, async (request) => {
    const code = mintCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    // Hashed in its normalized form -- redeem normalizes whatever the user typed back
    // (strips the display hyphen, uppercases) before hashing, so the two sides have to
    // agree on the same pre-hash shape or a freshly issued code would never match itself.
    await pool.query(
      `insert into transfer_codes (code_hash, player_id, expires_at) values ($1, $2, $3)`,
      [hashCode(normalizeCode(code)), request.principal.playerId, expiresAt],
    );
    return { code, expiresAt: expiresAt.toISOString() };
  });

  app.post(
    "/api/transfer/redeem",
    { preHandler: auth },
    async (request, reply) => {
      if (!redeemAllowed(request.ip)) {
        reply.code(429);
        return {
          error: { operation: "transfer_redeem", code: "rate_limited" },
        };
      }

      const body = request.body as { code?: string };
      const code = normalizeCode(body.code ?? "");
      if (!code) {
        reply.code(400);
        return {
          error: {
            operation: "transfer_redeem",
            code: "invalid_or_expired_code",
          },
        };
      }

      const { rows } = await pool.query(
        `select player_id from transfer_codes
         where code_hash = $1 and used_at is null and expires_at > now()`,
        [hashCode(code)],
      );
      if (!rows[0]) {
        reply.code(400);
        return {
          error: {
            operation: "transfer_redeem",
            code: "invalid_or_expired_code",
          },
        };
      }
      const sourcePlayerId = rows[0].player_id as string;
      const currentPlayerId = request.principal.playerId;

      if (sourcePlayerId === currentPlayerId) {
        reply.code(400);
        return {
          error: {
            operation: "transfer_redeem",
            code: "cannot_redeem_own_code",
          },
        };
      }
      // Merging the redeeming player away (mergePlayers deletes the "from" side) would
      // silently discard a real signed-in account if it's already linked to an identity --
      // the one outcome here that can't be undone. A guest redeeming is the supported case.
      if (request.principal.kind === "member") {
        reply.code(403);
        return {
          error: {
            operation: "transfer_redeem",
            code: "already_linked_account",
          },
        };
      }

      await pool.query(
        `update transfer_codes set used_at = now() where code_hash = $1`,
        [hashCode(code)],
      );
      await mergePlayers(pool, currentPlayerId, sourcePlayerId);
      await rotateSession(pool, request, reply, sourcePlayerId);

      return { ok: true, playerId: sourcePlayerId };
    },
  );
}
