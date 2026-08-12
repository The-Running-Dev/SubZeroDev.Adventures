/**
 * `computeRecords` (issue #19 follow-up) -- pure aggregates over a player's own session
 * history, plus the one cross-player field, `rarestEnding`. Seeds synthetic rows directly,
 * same style as `badges.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { computeRecords } from "./records.js";
import { longestConsecutiveRun } from "./badges.js";

// `computeRecords` now scopes its cross-player `discovererCounts` read to a caller-supplied
// core campaign id list (platform-baselines.ts) -- this suite has no real `ServerDemo`, so
// it stands in with every campaign id any fixture below actually seeds a session against,
// which is every campaign id in this file "counting as core" for these tests' purposes.
const CORE_CAMPAIGN_IDS = ["a", "b", "c", "popular", "rare"];

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("computeRecords", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate badges, achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  async function createPlayer(): Promise<string> {
    const playerId = randomUUID();
    await pool.query(
      `insert into players (player_id, kind) values ($1, 'guest')`,
      [playerId],
    );
    return playerId;
  }

  async function seedSession(
    playerId: string,
    opts: {
      campaignId?: string;
      status?: string;
      endingId?: string | null;
      stepCount?: number;
      attemptCounter?: number;
      createdAt: Date;
      updatedAt?: Date;
    },
  ): Promise<void> {
    await pool.query(
      `insert into sessions
         (session_id, blob, audience, attempt_counter, replay_compatible, profile_id,
          created_at, updated_at, campaign_id, status, ending_id, step_count)
       values ($1, '{}', 'player', $2, true, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        opts.attemptCounter ?? 1,
        playerId,
        opts.createdAt.toISOString(),
        (opts.updatedAt ?? opts.createdAt).toISOString(),
        opts.campaignId ?? "a",
        opts.status ?? "active",
        opts.endingId ?? null,
        opts.stepCount ?? 1,
      ],
    );
  }

  it("returns all zeros/nulls for a player with no sessions", async () => {
    const player = await createPlayer();
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records).toEqual({
      longestRun: 0,
      longestStreak: 0,
      mostMovesInADay: 0,
      favoriteDisk: null,
      mostRejectedMoves: 0,
      fastestEnding: null,
      rarestEnding: null,
      completionRate: 0,
      attemptEfficiency: 0,
    });
  });

  it("longestRun is the max single-session step count", async () => {
    const player = await createPlayer();
    await seedSession(player, { createdAt: new Date(), stepCount: 50 });
    await seedSession(player, { createdAt: new Date(), stepCount: 120 });
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records.longestRun).toBe(120);
  });

  it("longestStreak agrees with badges.ts's longestConsecutiveRun at its own boundaries", async () => {
    const player = await createPlayer();
    const dates = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const createdAt = new Date(Date.UTC(2026, 0, 1 + i, 12));
      dates.add(createdAt.toISOString().slice(0, 10));
      await seedSession(player, { createdAt });
    }
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records.longestStreak).toBe(longestConsecutiveRun(dates));
    expect(records.longestStreak).toBe(5);
  });

  it("mostMovesInADay sums step_count per UTC date, attributed to updated_at", async () => {
    const player = await createPlayer();
    const day = new Date(Date.UTC(2026, 0, 1, 12));
    await seedSession(player, { createdAt: day, stepCount: 100 });
    await seedSession(player, { createdAt: day, stepCount: 50 });
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records.mostMovesInADay).toBe(150);
  });

  it("favoriteDisk is the campaign with the most sessions", async () => {
    const player = await createPlayer();
    for (let i = 0; i < 3; i++) {
      await seedSession(player, {
        createdAt: new Date(),
        campaignId: "popular",
      });
    }
    await seedSession(player, { createdAt: new Date(), campaignId: "rare" });
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records.favoriteDisk).toEqual({
      campaignId: "popular",
      sessions: 3,
    });
  });

  it("mostRejectedMoves floors at zero", async () => {
    const player = await createPlayer();
    await seedSession(player, {
      createdAt: new Date(),
      stepCount: 10,
      attemptCounter: 5,
    });
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records.mostRejectedMoves).toBe(0);
  });

  it("fastestEnding is the minimum step count among ended sessions with an ending", async () => {
    const player = await createPlayer();
    await seedSession(player, {
      createdAt: new Date(),
      status: "ended",
      endingId: "e1",
      stepCount: 30,
    });
    await seedSession(player, {
      createdAt: new Date(),
      status: "ended",
      endingId: "e2",
      stepCount: 12,
    });
    // Not counted: no ending reached.
    await seedSession(player, { createdAt: new Date(), stepCount: 1 });
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records.fastestEnding).toBe(12);
  });

  it("rarestEnding picks the (campaign, ending) with the fewest global discoverers", async () => {
    const common = await createPlayer();
    const rare = await createPlayer();
    const subject = await createPlayer();

    // Three players discover "popular-ending"; only the subject discovers "rare-ending".
    for (const player of [common, rare, subject]) {
      await seedSession(player, {
        createdAt: new Date(),
        status: "ended",
        campaignId: "c",
        endingId: "popular-ending",
      });
    }
    await seedSession(subject, {
      createdAt: new Date(),
      status: "ended",
      campaignId: "c",
      endingId: "rare-ending",
    });

    const records = await computeRecords(pool, subject, CORE_CAMPAIGN_IDS);
    expect(records.rarestEnding).toEqual({
      campaignId: "c",
      endingId: "rare-ending",
      discoverers: 1,
    });
  });

  it("completionRate and attemptEfficiency are plain ratios", async () => {
    const player = await createPlayer();
    await seedSession(player, {
      createdAt: new Date(),
      status: "ended",
      stepCount: 10,
      attemptCounter: 10,
    });
    await seedSession(player, {
      createdAt: new Date(),
      status: "active",
      stepCount: 10,
      attemptCounter: 20,
    });
    const records = await computeRecords(pool, player, CORE_CAMPAIGN_IDS);
    expect(records.completionRate).toBe(0.5);
    // 20 total steps / 30 total attempts.
    expect(records.attemptEfficiency).toBeCloseTo(20 / 30);
  });
});
