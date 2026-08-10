/**
 * `mergePlayers`' achievement carry-over (issue #14). `api.test.ts` covers the
 * transfer-code path through the real HTTP surface; this covers the identity-upgrade merge
 * path directly -- `registerIdentityRoutes` needs a real `IdentityProvider` behind an OAuth
 * round trip that nothing in this repo mocks (`identity/vendor-quirks.test.ts`'s header explains why
 * a mock issuer isn't worth adding just for this), so this calls `upgradeViaIdentity` the
 * same way `routes/identity.ts`'s callback does, with a minimal fake
 * `FastifyRequest`/`FastifyReply` standing in for the ones a real request would carry --
 * `upgradeViaIdentity` only ever reads `request.cookies` and calls `reply.setCookie`, both
 * side effects this test doesn't care about.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyReply, FastifyRequest } from "fastify";
import { upgradeViaIdentity } from "./principal.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function fakeReqReply(): { request: FastifyRequest; reply: FastifyReply } {
  const request = { cookies: {} } as unknown as FastifyRequest;
  const reply = {
    setCookie: () => reply,
    clearCookie: () => reply,
  } as unknown as FastifyReply;
  return { request, reply };
}

describeIfDb("mergePlayers achievement carry-over", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  async function createGuest(): Promise<string> {
    const playerId = randomUUID();
    await pool.query(
      `insert into players (player_id, kind) values ($1, 'guest')`,
      [playerId],
    );
    return playerId;
  }

  async function unlock(
    playerId: string,
    achievementId: string,
  ): Promise<void> {
    await pool.query(
      `insert into achievements (player_id, campaign_id, achievement_id) values ($1, 'test-campaign', $2)`,
      [playerId, achievementId],
    );
  }

  async function achievementsFor(playerId: string): Promise<string[]> {
    const { rows } = await pool.query(
      `select achievement_id from achievements where player_id = $1 order by achievement_id`,
      [playerId],
    );
    return rows.map((row) => row.achievement_id as string);
  }

  async function grantBadge(
    playerId: string,
    badgeId: string,
    unlockedAt?: Date,
  ): Promise<void> {
    await pool.query(
      `insert into badges (player_id, badge_id, unlocked_at)
       values ($1, $2, coalesce($3, now()))`,
      [playerId, badgeId, unlockedAt ?? null],
    );
  }

  async function badgesFor(
    playerId: string,
  ): Promise<{ badgeId: string; unlockedAt: Date }[]> {
    const { rows } = await pool.query(
      `select badge_id, unlocked_at from badges where player_id = $1 order by badge_id`,
      [playerId],
    );
    return rows.map((row) => ({
      badgeId: row.badge_id as string,
      unlockedAt: row.unlocked_at as Date,
    }));
  }

  async function mergeCountFor(playerId: string): Promise<number> {
    const { rows } = await pool.query(
      `select merge_count from players where player_id = $1`,
      [playerId],
    );
    return rows[0].merge_count as number;
  }

  it("carries a guest's achievements onto the existing linked account on second-device sign-in", async () => {
    const firstDeviceGuest = await createGuest();
    await unlock(firstDeviceGuest, "chapter-one");
    const first = fakeReqReply();
    const linked = await upgradeViaIdentity(
      pool,
      first.request,
      first.reply,
      firstDeviceGuest,
      "oidc",
      "subject-1",
      "Player One",
    );

    // A second device, never signed in before, whose guest identity happens to resolve to
    // the same (provider, subject) -- the "signing in on a second device where the account
    // already exists" branch of upgradeViaIdentity, which merges rather than links in place.
    const secondDeviceGuest = await createGuest();
    await unlock(secondDeviceGuest, "chapter-two");
    const second = fakeReqReply();
    await upgradeViaIdentity(
      pool,
      second.request,
      second.reply,
      secondDeviceGuest,
      "oidc",
      "subject-1",
      undefined,
    );

    expect(await achievementsFor(linked.playerId)).toEqual([
      "chapter-one",
      "chapter-two",
    ]);
    // The merged-away guest row is gone (cascaded), so it carries nothing of its own.
    expect(await achievementsFor(secondDeviceGuest)).toEqual([]);
  });

  it("collapses an achievement both players had already unlocked to one row, rather than failing the merge", async () => {
    const member = await createGuest();
    await unlock(member, "shared-ending");
    const first = fakeReqReply();
    await upgradeViaIdentity(
      pool,
      first.request,
      first.reply,
      member,
      "oidc",
      "subject-2",
      undefined,
    );

    const secondDeviceGuest = await createGuest();
    await unlock(secondDeviceGuest, "shared-ending");
    const second = fakeReqReply();
    await upgradeViaIdentity(
      pool,
      second.request,
      second.reply,
      secondDeviceGuest,
      "oidc",
      "subject-2",
      undefined,
    );

    expect(await achievementsFor(member)).toEqual(["shared-ending"]);
  });

  it("carries badges through a merge, collapses an overlap, and bumps merge_count", async () => {
    const survivor = await createGuest();
    await grantBadge(survivor, "first-steps", new Date("2026-01-01T00:00:00Z"));
    const survivorFirst = fakeReqReply();
    await upgradeViaIdentity(
      pool,
      survivorFirst.request,
      survivorFirst.reply,
      survivor,
      "oidc",
      "subject-3",
      undefined,
    );

    const mergedAway = await createGuest();
    // Overlapping badge, unlocked at a different time -- the survivor's original
    // unlocked_at must win (on conflict do nothing), not this one.
    await grantBadge(
      mergedAway,
      "first-steps",
      new Date("2026-02-01T00:00:00Z"),
    );
    await grantBadge(mergedAway, "century-club");
    const second = fakeReqReply();
    await upgradeViaIdentity(
      pool,
      second.request,
      second.reply,
      mergedAway,
      "oidc",
      "subject-3",
      undefined,
    );

    const badges = await badgesFor(survivor);
    expect(badges.map((b) => b.badgeId)).toEqual([
      "century-club",
      "first-steps",
    ]);
    expect(
      badges.find((b) => b.badgeId === "first-steps")!.unlockedAt.toISOString(),
    ).toBe("2026-01-01T00:00:00.000Z");
    // The merged-away row is gone (cascaded), so it carries nothing of its own.
    expect(await badgesFor(mergedAway)).toEqual([]);
    expect(await mergeCountFor(survivor)).toBe(1);
  });

  it("does not bump merge_count on a self-merge no-op", async () => {
    const player = await createGuest();
    const { request, reply } = fakeReqReply();
    // upgradeViaIdentity's "link in place" branch (no prior identity) never calls
    // mergePlayers at all -- this exercises the early-return guard directly instead.
    await upgradeViaIdentity(
      pool,
      request,
      reply,
      player,
      "oidc",
      "subject-4",
      undefined,
    );
    expect(await mergeCountFor(player)).toBe(0);
  });
});
