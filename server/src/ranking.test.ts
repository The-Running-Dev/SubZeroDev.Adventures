/**
 * `ranking.ts` -- the pure formula/tie-break/crown logic first (no database, runs
 * everywhere), then the query it's built on (`platform-baselines.ts`'s
 * `publicProfileTotals`) and the routes that expose it, against a live Postgres.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import {
  CROWN_BADGE_ID,
  CROWN_MIN_RANKED_PLAYERS,
  absurdityIndexOf,
  compareEntries,
  computeLeaderboard,
  currentLeaderPlayerId,
  rankProfiles,
} from "./ranking.js";
import type { PublicProfileTotal } from "./platform-baselines.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

// `computeLeaderboard`/`currentLeaderPlayerId` now scope their cross-player session read to
// a caller-supplied core campaign id list (platform-baselines.ts's `publicProfileTotals`) --
// this suite has no real `ServerDemo`, so it stands in with every campaign id any fixture
// below actually seeds a session against.
const CORE_CAMPAIGN_IDS = [
  "a",
  "what-would-lucifer-do",
  "what-would-lucifer-do-engineers-cut",
];

function total(
  overrides: Partial<PublicProfileTotal> = {},
): PublicProfileTotal {
  return {
    playerId: overrides.playerId ?? "p",
    profileSlug: overrides.profileSlug ?? "slug",
    displayName: overrides.displayName ?? null,
    createdAtMs: overrides.createdAtMs ?? 0,
    badgeCount: overrides.badgeCount ?? 0,
    firstBadgeAtMs: overrides.firstBadgeAtMs ?? null,
    moves: overrides.moves ?? 0,
    rejected: overrides.rejected ?? 0,
    endings: overrides.endings ?? 0,
  };
}

function comparable(
  overrides: Partial<PublicProfileTotal & { absurdityIndex: number }> = {},
): PublicProfileTotal & { absurdityIndex: number } {
  return { ...total(overrides), absurdityIndex: overrides.absurdityIndex ?? 0 };
}

describe("absurdityIndexOf", () => {
  it("is zero for all-zero input", () => {
    expect(
      absurdityIndexOf({ badgeCount: 0, rejected: 0, endings: 0, moves: 0 }),
    ).toBe(0);
  });

  it("weights each term independently", () => {
    expect(
      absurdityIndexOf({ badgeCount: 1, rejected: 0, endings: 0, moves: 0 }),
    ).toBe(100);
    expect(
      absurdityIndexOf({ badgeCount: 0, rejected: 1, endings: 0, moves: 0 }),
    ).toBe(5);
    expect(
      absurdityIndexOf({ badgeCount: 0, rejected: 0, endings: 1, moves: 0 }),
    ).toBe(25);
    expect(
      absurdityIndexOf({ badgeCount: 0, rejected: 0, endings: 0, moves: 10 }),
    ).toBe(1);
  });

  it("truncates the moves term rather than rounding", () => {
    expect(
      absurdityIndexOf({ badgeCount: 0, rejected: 0, endings: 0, moves: 95 }),
    ).toBe(9);
    expect(
      absurdityIndexOf({ badgeCount: 0, rejected: 0, endings: 0, moves: 100 }),
    ).toBe(10);
  });

  it("sums every term for a mixed case", () => {
    expect(
      absurdityIndexOf({ badgeCount: 3, rejected: 4, endings: 2, moves: 37 }),
    ).toBe(300 + 20 + 50 + 3);
  });
});

describe("compareEntries", () => {
  it("orders by absurdityIndex desc first", () => {
    const a = comparable({ absurdityIndex: 100 });
    const b = comparable({ absurdityIndex: 50 });
    expect(compareEntries(a, b)).toBeLessThan(0);
    expect(compareEntries(b, a)).toBeGreaterThan(0);
  });

  it("falls back to badgeCount desc on an index tie", () => {
    const a = comparable({ absurdityIndex: 10, badgeCount: 5 });
    const b = comparable({ absurdityIndex: 10, badgeCount: 3 });
    expect(compareEntries(a, b)).toBeLessThan(0);
  });

  it("falls back to rejected desc on an index+badge tie", () => {
    const a = comparable({ absurdityIndex: 10, badgeCount: 5, rejected: 20 });
    const b = comparable({ absurdityIndex: 10, badgeCount: 5, rejected: 10 });
    expect(compareEntries(a, b)).toBeLessThan(0);
  });

  it("falls back to moves desc on an index+badge+rejected tie", () => {
    const a = comparable({
      absurdityIndex: 10,
      badgeCount: 5,
      rejected: 10,
      moves: 200,
    });
    const b = comparable({
      absurdityIndex: 10,
      badgeCount: 5,
      rejected: 10,
      moves: 100,
    });
    expect(compareEntries(a, b)).toBeLessThan(0);
  });

  it("falls back to firstBadgeAtMs asc, with null sorting last", () => {
    const earlier = comparable({ firstBadgeAtMs: 100 });
    const never = comparable({ firstBadgeAtMs: null });
    expect(compareEntries(earlier, never)).toBeLessThan(0);
    expect(compareEntries(never, earlier)).toBeGreaterThan(0);
  });

  it("falls back to players.createdAtMs asc on a full tie through firstBadgeAtMs", () => {
    const older = comparable({ createdAtMs: 100 });
    const newer = comparable({ createdAtMs: 200 });
    expect(compareEntries(older, newer)).toBeLessThan(0);
  });

  it("falls back to profileSlug asc as the final, total tiebreaker", () => {
    const a = comparable({ profileSlug: "aaa" });
    const b = comparable({ profileSlug: "bbb" });
    expect(compareEntries(a, b)).toBeLessThan(0);
    expect(compareEntries(b, a)).toBeGreaterThan(0);
    expect(compareEntries(a, a)).toBe(0);
  });
});

describe("rankProfiles", () => {
  it("assigns 1..n with no gaps or duplicates, ordered by index desc", () => {
    const totals = [
      total({ playerId: "a", profileSlug: "a", badgeCount: 1 }),
      total({ playerId: "b", profileSlug: "b", badgeCount: 3 }),
      total({ playerId: "c", profileSlug: "c", badgeCount: 2 }),
    ];
    const ranked = rankProfiles(totals);
    expect(ranked.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(ranked.map((r) => r.profileSlug)).toEqual(["b", "c", "a"]);
  });

  it("crowns nobody below CROWN_MIN_RANKED_PLAYERS even with a strong leader", () => {
    expect(CROWN_MIN_RANKED_PLAYERS).toBe(3);
    const totals = [
      total({ playerId: "a", profileSlug: "a", badgeCount: 5 }),
      total({ playerId: "b", profileSlug: "b", badgeCount: 1 }),
    ];
    const ranked = rankProfiles(totals);
    expect(ranked.every((r) => !r.crowned)).toBe(true);
  });

  it("crowns exactly position 1 once at or above the floor with a nonzero index", () => {
    const totals = [
      total({ playerId: "a", profileSlug: "a", badgeCount: 5 }),
      total({ playerId: "b", profileSlug: "b", badgeCount: 3 }),
      total({ playerId: "c", profileSlug: "c", badgeCount: 1 }),
    ];
    const ranked = rankProfiles(totals);
    expect(ranked[0]!.crowned).toBe(true);
    expect(ranked.slice(1).every((r) => !r.crowned)).toBe(true);
  });

  it("does not crown a zero-index leader", () => {
    const totals = [
      total({ playerId: "a", profileSlug: "a" }),
      total({ playerId: "b", profileSlug: "b" }),
      total({ playerId: "c", profileSlug: "c" }),
    ];
    const ranked = rankProfiles(totals);
    expect(ranked.every((r) => !r.crowned)).toBe(true);
  });
});

describeIfDb("ranking against a live database", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate badges, achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  async function createPlayer(
    opts: {
      public?: boolean;
      slug?: string;
      displayName?: string | null;
      createdAt?: Date;
    } = {},
  ): Promise<string> {
    const playerId = randomUUID();
    await pool.query(
      `insert into players
         (player_id, kind, display_name, created_at, profile_public, profile_slug)
       values ($1, 'guest', $2, $3, $4, $5)`,
      [
        playerId,
        opts.displayName ?? null,
        (opts.createdAt ?? new Date()).toISOString(),
        opts.public ?? false,
        opts.slug ?? null,
      ],
    );
    return playerId;
  }

  async function seedSession(
    playerId: string | null,
    opts: {
      campaignId?: string;
      status?: string;
      endingId?: string | null;
      stepCount?: number;
      attemptCounter?: number;
      createdAt?: Date;
    } = {},
  ): Promise<void> {
    const createdAt = (opts.createdAt ?? new Date()).toISOString();
    await pool.query(
      `insert into sessions
         (session_id, blob, audience, attempt_counter, replay_compatible, profile_id,
          created_at, updated_at, campaign_id, status, ending_id, step_count)
       values ($1, '{}', 'player', $2, true, $3, $4, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        opts.attemptCounter ?? 1,
        playerId,
        createdAt,
        opts.campaignId ?? "a",
        opts.status ?? "active",
        opts.endingId ?? null,
        opts.stepCount ?? 1,
      ],
    );
  }

  async function seedBadge(playerId: string, badgeId: string): Promise<void> {
    await pool.query(
      `insert into badges (player_id, badge_id) values ($1, $2)`,
      [playerId, badgeId],
    );
  }

  it("orders three public players by their hand-chosen counters", async () => {
    const low = await createPlayer({ public: true, slug: "low" });
    const mid = await createPlayer({ public: true, slug: "mid" });
    const high = await createPlayer({ public: true, slug: "high" });
    await seedSession(low, { stepCount: 1, attemptCounter: 1 });
    await seedSession(mid, { stepCount: 1, attemptCounter: 11 }); // 10 rejected -> 50
    await seedSession(high, { stepCount: 1, attemptCounter: 51 }); // 50 rejected -> 250
    await seedBadge(high, "first-steps");

    const { entries } = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(entries.map((e) => e.profileSlug)).toEqual(["high", "mid", "low"]);
    expect(entries[0]!.position).toBe(1);
    expect(entries[0]!.absurdityIndex).toBe(100 + 250);
  });

  it("excludes a private player even with the strongest counters", async () => {
    const secret = await createPlayer({ public: false });
    await seedSession(secret, { stepCount: 1, attemptCounter: 999 });
    await createPlayer({ public: true, slug: "visible" });

    const { entries } = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(entries.map((e) => e.profileSlug)).toEqual(["visible"]);
  });

  it("includes a public player with zero sessions, all zeros, a valid position", async () => {
    await createPlayer({ public: true, slug: "untouched" });
    const { entries } = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(entries).toEqual([
      expect.objectContaining({
        profileSlug: "untouched",
        position: 1,
        absurdityIndex: 0,
        badgeCount: 0,
        rejected: 0,
        endings: 0,
        moves: 0,
      }),
    ]);
  });

  it("a session with a null profile_id contributes to nobody's totals", async () => {
    await createPlayer({ public: true, slug: "player" });
    await seedSession(null, { stepCount: 500, attemptCounter: 500 });
    const { entries } = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(entries[0]!.moves).toBe(0);
  });

  it("clamps rejected moves at zero when attempt_counter is under step_count", async () => {
    const player = await createPlayer({ public: true, slug: "player" });
    await seedSession(player, { stepCount: 10, attemptCounter: 5 });
    const { entries } = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(entries[0]!.rejected).toBe(0);
  });

  it("counts two campaigns sharing an ending id as two endings", async () => {
    const player = await createPlayer({ public: true, slug: "player" });
    await seedSession(player, {
      campaignId: "what-would-lucifer-do",
      status: "ended",
      endingId: "shared-ending",
    });
    await seedSession(player, {
      campaignId: "what-would-lucifer-do-engineers-cut",
      status: "ended",
      endingId: "shared-ending",
    });
    const { entries } = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(entries[0]!.endings).toBe(2);
  });

  it("excludes the crown badge from a player's own badgeCount and index", async () => {
    const player = await createPlayer({ public: true, slug: "player" });
    await seedBadge(player, "first-steps");
    const before = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(before.entries[0]!.badgeCount).toBe(1);

    await seedBadge(player, CROWN_BADGE_ID);
    const after = await computeLeaderboard(pool, CORE_CAMPAIGN_IDS);
    expect(after.entries[0]!.badgeCount).toBe(1);
    expect(after.entries[0]!.absurdityIndex).toBe(
      before.entries[0]!.absurdityIndex,
    );
  });

  it("currentLeaderPlayerId agrees with the crowned entry, and is null below the floor", async () => {
    const a = await createPlayer({ public: true, slug: "a" });
    await createPlayer({ public: true, slug: "b" });
    expect(await currentLeaderPlayerId(pool, CORE_CAMPAIGN_IDS)).toBeNull();

    await createPlayer({ public: true, slug: "c" });
    await seedBadge(a, "first-steps");
    expect(await currentLeaderPlayerId(pool, CORE_CAMPAIGN_IDS)).toBe(a);
  });

  it("/api/ranking and /api/profile/:slug agree on endingsFound and moves", async () => {
    const player = await createPlayer({ public: true, slug: "cross-page" });
    await seedSession(player, {
      campaignId: "what-would-lucifer-do",
      status: "ended",
      endingId: "shared-ending",
      stepCount: 7,
    });
    await seedSession(player, {
      campaignId: "what-would-lucifer-do-engineers-cut",
      status: "ended",
      endingId: "shared-ending",
      stepCount: 3,
    });

    const rankingBody = await app
      .inject({ method: "GET", url: "/api/ranking" })
      .then(
        (r) => r.json() as { entries: { endings: number; moves: number }[] },
      );
    const profileBody = await app
      .inject({ method: "GET", url: "/api/profile/cross-page" })
      .then((r) => r.json() as { endingsFound: number; stepsTaken: number });

    expect(rankingBody.entries[0]!.endings).toBe(profileBody.endingsFound);
    expect(rankingBody.entries[0]!.moves).toBe(profileBody.stepsTaken);
  });

  it("GET /api/ranking never mints a player and exposes no player_id", async () => {
    const before = await pool.query<{ n: string }>(
      "select count(*)::int as n from players",
    );
    const response = await app.inject({ method: "GET", url: "/api/ranking" });
    expect(response.statusCode).toBe(200);
    const after = await pool.query<{ n: string }>(
      "select count(*)::int as n from players",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(JSON.stringify(response.json())).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});
