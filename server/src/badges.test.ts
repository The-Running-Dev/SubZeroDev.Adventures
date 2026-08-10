/**
 * Predicate-level tests for badge evaluation (issue #19). Seeds synthetic `players`/
 * `sessions`/`achievements` rows directly via `pool.query` -- the same style as
 * `principal.test.ts` -- rather than driving real gameplay, since what's under test is the
 * arithmetic over stored rows, not the engine. A minimal `blob` of `{"kindId":"..."}` is
 * enough for every predicate: none of them read anything else off it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createServerDemo, type ServerDemo } from "./composition.js";
import { evaluateBadges } from "./badges.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const DAY_MS = 86_400_000;

describeIfDb("badge evaluation", () => {
  let pool: Pool;
  let demo: ServerDemo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    demo = await createServerDemo(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate badges, achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  async function createPlayer(mergeCount = 0): Promise<string> {
    const playerId = randomUUID();
    await pool.query(
      `insert into players (player_id, kind, merge_count) values ($1, 'guest', $2)`,
      [playerId, mergeCount],
    );
    return playerId;
  }

  interface SessionSeed {
    campaignId?: string;
    status?: string;
    endingId?: string | null;
    stepCount?: number;
    attemptCounter?: number;
    createdAt: Date;
    updatedAt?: Date;
    kindId?: string;
  }

  async function seedSession(
    playerId: string,
    seed: SessionSeed,
  ): Promise<void> {
    const createdAt = seed.createdAt.toISOString();
    const updatedAt = (seed.updatedAt ?? seed.createdAt).toISOString();
    const blob = JSON.stringify({ kindId: seed.kindId ?? "story-graph" });
    await pool.query(
      `insert into sessions
         (session_id, blob, audience, attempt_counter, replay_compatible, profile_id,
          created_at, updated_at, campaign_id, status, ending_id, step_count)
       values ($1, $2, 'player', $3, true, $4, $5, $6, $7, $8, $9, $10)`,
      [
        randomUUID(),
        blob,
        seed.attemptCounter ?? 1,
        playerId,
        createdAt,
        updatedAt,
        seed.campaignId ?? "test-campaign",
        seed.status ?? "active",
        seed.endingId ?? null,
        seed.stepCount ?? 1,
      ],
    );
  }

  async function unlock(
    playerId: string,
    campaignId: string,
    achievementId: string,
  ) {
    await pool.query(
      `insert into achievements (player_id, campaign_id, achievement_id) values ($1, $2, $3)`,
      [playerId, campaignId, achievementId],
    );
  }

  async function badgeIdsFor(playerId: string): Promise<string[]> {
    const rows = await evaluateBadges(pool, demo, playerId);
    return rows.map((r) => r.badgeId).sort();
  }

  it("awards first-steps for any session at all, and nothing for a player with none", async () => {
    const withSession = await createPlayer();
    await seedSession(withSession, { createdAt: new Date() });
    expect(await badgeIdsFor(withSession)).toContain("first-steps");

    const withNone = await createPlayer();
    expect(await badgeIdsFor(withNone)).toEqual([]);
  });

  it("witching-hour fires at UTC hour 3 and not at hour 4", async () => {
    const at3 = await createPlayer();
    await seedSession(at3, { createdAt: new Date("2026-01-01T03:30:00.000Z") });
    expect(await badgeIdsFor(at3)).toContain("witching-hour");

    const at4 = await createPlayer();
    await seedSession(at4, { createdAt: new Date("2026-01-01T04:30:00.000Z") });
    expect(await badgeIdsFor(at4)).not.toContain("witching-hour");
  });

  it("ghosted-it requires an untouched session 30+ days old, not 29", async () => {
    const now = Date.now();
    const old = await createPlayer();
    await seedSession(old, { createdAt: new Date(now - 31 * DAY_MS) });
    expect(await badgeIdsFor(old)).toContain("ghosted-it");

    const almost = await createPlayer();
    await seedSession(almost, { createdAt: new Date(now - 29 * DAY_MS) });
    expect(await badgeIdsFor(almost)).not.toContain("ghosted-it");

    // Touched again since creation -- not ghosted, regardless of age.
    const touched = await createPlayer();
    await seedSession(touched, {
      createdAt: new Date(now - 40 * DAY_MS),
      updatedAt: new Date(now - 1 * DAY_MS),
    });
    expect(await badgeIdsFor(touched)).not.toContain("ghosted-it");
  });

  it("slow-burn requires a still-open session 90+ days old", async () => {
    const now = Date.now();
    const open = await createPlayer();
    await seedSession(open, {
      createdAt: new Date(now - 91 * DAY_MS),
      status: "active",
    });
    expect(await badgeIdsFor(open)).toContain("slow-burn");

    const finished = await createPlayer();
    await seedSession(finished, {
      createdAt: new Date(now - 91 * DAY_MS),
      status: "ended",
    });
    expect(await badgeIdsFor(finished)).not.toContain("slow-burn");
  });

  it("streak fires on 7 consecutive UTC days and not on a run with a gap", async () => {
    const consecutive = await createPlayer();
    for (let i = 0; i < 7; i++) {
      await seedSession(consecutive, {
        createdAt: new Date(Date.UTC(2026, 0, 1 + i, 12)),
      });
    }
    expect(await badgeIdsFor(consecutive)).toContain("streak");

    const gapped = await createPlayer();
    for (const day of [1, 2, 3, 4, 6, 7, 8]) {
      await seedSession(gapped, {
        createdAt: new Date(Date.UTC(2026, 0, day, 12)),
      });
    }
    expect(await badgeIdsFor(gapped)).not.toContain("streak");
  });

  it("century-club sums step_count across every session", async () => {
    const player = await createPlayer();
    await seedSession(player, { createdAt: new Date(), stepCount: 600 });
    await seedSession(player, { createdAt: new Date(), stepCount: 401 });
    expect(await badgeIdsFor(player)).toContain("century-club");
  });

  it("sleep-schedule-nonexistent needs all 24 hours, not 23", async () => {
    const player = await createPlayer();
    for (let hour = 0; hour < 24; hour++) {
      await seedSession(player, {
        createdAt: new Date(Date.UTC(2026, 0, 1, hour)),
      });
    }
    expect(await badgeIdsFor(player)).toContain("sleep-schedule-nonexistent");

    const almost = await createPlayer();
    for (let hour = 0; hour < 23; hour++) {
      await seedSession(almost, {
        createdAt: new Date(Date.UTC(2026, 0, 1, hour)),
      });
    }
    expect(await badgeIdsFor(almost)).not.toContain(
      "sleep-schedule-nonexistent",
    );
  });

  it("chaos-gremlin fires past the threshold, not at it", async () => {
    // Threshold: attemptCounter > stepCount * 3 + 5. At stepCount=10, that's 35.
    const over = await createPlayer();
    await seedSession(over, {
      createdAt: new Date(),
      stepCount: 10,
      attemptCounter: 36,
    });
    expect(await badgeIdsFor(over)).toContain("chaos-gremlin");

    const atLimit = await createPlayer();
    await seedSession(atLimit, {
      createdAt: new Date(),
      stepCount: 10,
      attemptCounter: 35,
    });
    expect(await badgeIdsFor(atLimit)).not.toContain("chaos-gremlin");
  });

  it("zen-master requires status ended, not just a clean attempt count", async () => {
    const ended = await createPlayer();
    await seedSession(ended, {
      createdAt: new Date(),
      status: "ended",
      stepCount: 10,
      attemptCounter: 11,
    });
    expect(await badgeIdsFor(ended)).toContain("zen-master");

    const active = await createPlayer();
    await seedSession(active, {
      createdAt: new Date(),
      status: "active",
      stepCount: 10,
      attemptCounter: 11,
    });
    expect(await badgeIdsFor(active)).not.toContain("zen-master");
  });

  it("math-is-hard fires when attempt_counter is somehow less than step_count", async () => {
    const player = await createPlayer();
    await seedSession(player, {
      createdAt: new Date(),
      stepCount: 10,
      attemptCounter: 5,
    });
    expect(await badgeIdsFor(player)).toContain("math-is-hard");
  });

  it("achievement-blackout needs 3+ finished campaigns with zero achievements each", async () => {
    const player = await createPlayer();
    for (const campaignId of ["a", "b", "c"]) {
      await seedSession(player, {
        createdAt: new Date(),
        campaignId,
        status: "ended",
      });
    }
    expect(await badgeIdsFor(player)).toContain("achievement-blackout");

    // One of the three has an achievement -- no longer a blackout.
    const partial = await createPlayer();
    for (const campaignId of ["a", "b", "c"]) {
      await seedSession(partial, {
        createdAt: new Date(),
        campaignId,
        status: "ended",
      });
    }
    await unlock(partial, "a", "some-achievement");
    expect(await badgeIdsFor(partial)).not.toContain("achievement-blackout");
  });

  it("collector needs achievements spanning 3+ distinct campaigns", async () => {
    const player = await createPlayer();
    await unlock(player, "a", "x");
    await unlock(player, "b", "x");
    await unlock(player, "c", "x");
    expect(await badgeIdsFor(player)).toContain("collector");

    const two = await createPlayer();
    await unlock(two, "a", "x");
    await unlock(two, "b", "x");
    expect(await badgeIdsFor(two)).not.toContain("collector");
  });

  it("one-job needs a single campaign across 10+ sessions", async () => {
    const player = await createPlayer();
    for (let i = 0; i < 10; i++) {
      await seedSession(player, {
        createdAt: new Date(),
        campaignId: "only-one",
      });
    }
    expect(await badgeIdsFor(player)).toContain("one-job");

    const twoJobs = await createPlayer();
    for (let i = 0; i < 9; i++) {
      await seedSession(twoJobs, {
        createdAt: new Date(),
        campaignId: "job-a",
      });
    }
    await seedSession(twoJobs, { createdAt: new Date(), campaignId: "job-b" });
    expect(await badgeIdsFor(twoJobs)).not.toContain("one-job");
  });

  it("frequent-flyer reads merge_count from players", async () => {
    const flyer = await createPlayer(2);
    expect(await badgeIdsFor(flyer)).toContain("frequent-flyer");

    const onceOnly = await createPlayer(1);
    expect(await badgeIdsFor(onceOnly)).not.toContain("frequent-flyer");
  });

  it("multiclass fires once every catalog kind has been played (currently just story-graph)", async () => {
    const player = await createPlayer();
    await seedSession(player, { createdAt: new Date(), kindId: "story-graph" });
    // Known limitation, asserted explicitly: every shipped campaign is story-graph today,
    // so a single session already satisfies this. See docs/player-model.md-adjacent notes
    // in the badges.ts header and the implementation plan.
    expect(
      [...demo.all.map((c) => c.kindId)].every((k) => k === "story-graph"),
    ).toBe(true);
    expect(await badgeIdsFor(player)).toContain("multiclass");
  });

  it("completionist fires once every ending of a real campaign is discovered", async () => {
    const campaign = demo.all.find((c) => c.endingCount > 0);
    expect(campaign).toBeDefined();

    // The predicate only counts distinct `ending_id`s against `endingCount` -- it never
    // reads the engine or checks the ids are ones the campaign actually declares -- so
    // synthetic labels are enough to prove the arithmetic without driving real gameplay.
    const player = await createPlayer();
    for (let i = 0; i < campaign!.endingCount; i++) {
      await seedSession(player, {
        createdAt: new Date(),
        campaignId: campaign!.campaignId,
        status: "ended",
        endingId: `synthetic-ending-${i}`,
      });
    }
    expect(await badgeIdsFor(player)).toContain("completionist");
  });

  it("is idempotent: re-evaluating does not change unlocked_at", async () => {
    const player = await createPlayer();
    await seedSession(player, { createdAt: new Date() });
    const first = await evaluateBadges(pool, demo, player);
    const firstSteps = first.find((b) => b.badgeId === "first-steps");
    expect(firstSteps).toBeDefined();

    const second = await evaluateBadges(pool, demo, player);
    const secondFirstSteps = second.find((b) => b.badgeId === "first-steps");
    expect(secondFirstSteps?.unlockedAt).toBe(firstSteps?.unlockedAt);
  });
});
