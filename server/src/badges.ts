/**
 * Badge evaluation. Stored, not computed per request (same posture as the achievements
 * table, 004): `GET /api/badges` (routes/badges.ts) re-evaluates and upserts on every
 * call, so `unlocked_at` records the first request after a badge was actually earned, not
 * some later moment it happened to be displayed.
 *
 * Deliberately three queries and eighteen in-memory predicates rather than eighteen SQL
 * predicates -- a player's whole session history is a few dozen rows at most, and keeping
 * every rule as a readable JS function next to the assumption it depends on matters more
 * here than SQL purity.
 *
 * Time handling is UTC-only, on purpose. `sessions.created_at`/`updated_at` are ISO-8601
 * strings written by JS `Date.toISOString()` (server/src/persistence.ts) -- there is no
 * player timezone stored anywhere, so "3am" and "seven days in a row" mean 3am UTC and
 * seven UTC calendar days. Not a bug to fix later without a schema change.
 */
import type { Pool } from "pg";
import type { ServerDemo } from "./composition.js";

export interface BadgeRow {
  readonly badgeId: string;
  readonly unlockedAt: string;
}

interface SessionFacts {
  readonly campaignId: string;
  readonly status: string;
  readonly endingId: string | null;
  readonly stepCount: number;
  /** NOTE: dual-purposed as the optimistic-lock version (persistence.ts bumps it on every
   *  write, including createSession and loadGame, not just a rejected move), so this is an
   *  *approximate* proxy for "attempts beyond what was accepted", never an exact one. Every
   *  badge that reads it uses a deliberately loose threshold. */
  readonly attemptCounter: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly kindId: string | null;
}

interface BadgeData {
  readonly sessions: readonly SessionFacts[];
  readonly achievements: readonly {
    campaignId: string;
    achievementId: string;
  }[];
  readonly mergeCount: number;
  readonly catalogKindIds: ReadonlySet<string>;
  endingTotalOf(campaignId: string): number;
  readonly now: number;
}

interface BadgeDefinition {
  readonly id: string;
  readonly test: (data: BadgeData) => boolean;
}

const MARATHON_STEPS = 200;
const CENTURY_STEPS = 1000;
const GHOSTED_DAYS = 30;
const SLOW_BURN_DAYS = 90;
const STREAK_DAYS = 7;
const DAY_MS = 86_400_000;
const SEASONED_CAMPAIGNS = 5;
const COLLECTOR_CAMPAIGNS = 3;
const ONE_JOB_SESSIONS = 10;
const BLACKOUT_CAMPAIGNS = 3;

function hourUtc(iso: string): number {
  return new Date(iso).getUTCHours();
}

function dayUtc(iso: string): string {
  return iso.slice(0, 10);
}

function distinct<T>(values: Iterable<T>): Set<T> {
  return new Set(values);
}

/** True when some run of `days` consecutive calendar dates (UTC, `YYYY-MM-DD` strings)
 *  all appear in `dates`. */
function hasConsecutiveRun(dates: ReadonlySet<string>, days: number): boolean {
  const sorted = [...dates].sort();
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = Date.parse(sorted[i]) - Date.parse(sorted[i - 1]);
    run = gap === DAY_MS ? run + 1 : 1;
    if (run >= days) return true;
  }
  return days <= 1 && sorted.length >= 1;
}

export const BADGES: readonly BadgeDefinition[] = [
  {
    id: "first-steps",
    test: (d) => d.sessions.length > 0,
  },
  {
    id: "completionist",
    test: (d) => {
      const byCampaign = new Map<string, Set<string>>();
      for (const s of d.sessions) {
        if (!s.endingId) continue;
        const set = byCampaign.get(s.campaignId) ?? new Set<string>();
        set.add(s.endingId);
        byCampaign.set(s.campaignId, set);
      }
      for (const [campaignId, endings] of byCampaign) {
        const total = d.endingTotalOf(campaignId);
        if (total > 0 && endings.size >= total) return true;
      }
      return false;
    },
  },
  {
    id: "collector",
    test: (d) =>
      distinct(d.achievements.map((a) => a.campaignId)).size >=
      COLLECTOR_CAMPAIGNS,
  },
  {
    id: "marathoner",
    test: (d) => d.sessions.some((s) => s.stepCount >= MARATHON_STEPS),
  },
  {
    id: "seasoned",
    test: (d) =>
      distinct(
        d.sessions.filter((s) => s.status === "ended").map((s) => s.campaignId),
      ).size >= SEASONED_CAMPAIGNS,
  },
  {
    id: "witching-hour",
    test: (d) =>
      d.sessions.some(
        (s) => hourUtc(s.createdAt) === 3 || hourUtc(s.updatedAt) === 3,
      ),
  },
  {
    id: "ghosted-it",
    test: (d) =>
      d.sessions.some(
        (s) =>
          s.createdAt === s.updatedAt &&
          d.now - Date.parse(s.createdAt) >= GHOSTED_DAYS * DAY_MS,
      ),
  },
  {
    id: "one-job",
    test: (d) =>
      distinct(d.sessions.map((s) => s.campaignId)).size === 1 &&
      d.sessions.length >= ONE_JOB_SESSIONS,
  },
  {
    id: "chaos-gremlin",
    test: (d) => d.sessions.some((s) => s.attemptCounter > s.stepCount * 3 + 5),
  },
  {
    id: "zen-master",
    test: (d) =>
      d.sessions.some(
        (s) => s.status === "ended" && s.attemptCounter - s.stepCount <= 1,
      ),
  },
  {
    id: "multiclass",
    test: (d) => {
      if (d.catalogKindIds.size === 0) return false;
      const played = distinct(
        d.sessions.map((s) => s.kindId).filter((k): k is string => k !== null),
      );
      for (const kind of d.catalogKindIds) {
        if (!played.has(kind)) return false;
      }
      return true;
    },
  },
  {
    id: "slow-burn",
    test: (d) =>
      d.sessions.some(
        (s) =>
          s.status !== "ended" &&
          d.now - Date.parse(s.createdAt) >= SLOW_BURN_DAYS * DAY_MS,
      ),
  },
  {
    id: "streak",
    test: (d) => {
      const dates = new Set<string>();
      for (const s of d.sessions) {
        dates.add(dayUtc(s.createdAt));
        dates.add(dayUtc(s.updatedAt));
      }
      return hasConsecutiveRun(dates, STREAK_DAYS);
    },
  },
  {
    id: "century-club",
    test: (d) =>
      d.sessions.reduce((sum, s) => sum + s.stepCount, 0) >= CENTURY_STEPS,
  },
  {
    id: "achievement-blackout",
    test: (d) => {
      const achievedCampaigns = distinct(
        d.achievements.map((a) => a.campaignId),
      );
      const endedCampaigns = distinct(
        d.sessions.filter((s) => s.status === "ended").map((s) => s.campaignId),
      );
      let blackouts = 0;
      for (const campaignId of endedCampaigns) {
        if (!achievedCampaigns.has(campaignId)) blackouts++;
      }
      return blackouts >= BLACKOUT_CAMPAIGNS;
    },
  },
  {
    id: "sleep-schedule-nonexistent",
    test: (d) => {
      const hours = new Set<number>();
      for (const s of d.sessions) {
        hours.add(hourUtc(s.createdAt));
        hours.add(hourUtc(s.updatedAt));
      }
      return hours.size >= 24;
    },
  },
  {
    id: "frequent-flyer",
    test: (d) => d.mergeCount >= 2,
  },
  {
    id: "math-is-hard",
    test: (d) => d.sessions.some((s) => s.attemptCounter < s.stepCount),
  },
];

interface SessionRow {
  campaign_id: string;
  status: string;
  ending_id: string | null;
  step_count: number;
  attempt_counter: number;
  created_at: string;
  updated_at: string;
  kind_id: string | null;
}

interface AchievementRow {
  campaign_id: string;
  achievement_id: string;
}

export async function evaluateBadges(
  pool: Pool,
  demo: ServerDemo,
  playerId: string,
): Promise<BadgeRow[]> {
  const [sessionsResult, achievementsResult, playerResult] = await Promise.all([
    pool.query<SessionRow>(
      `select campaign_id, status, ending_id, step_count, attempt_counter,
              created_at, updated_at, blob::jsonb ->> 'kindId' as kind_id
         from sessions where profile_id = $1`,
      [playerId],
    ),
    pool.query<AchievementRow>(
      `select campaign_id, achievement_id from achievements where player_id = $1`,
      [playerId],
    ),
    pool.query<{ merge_count: number }>(
      `select merge_count from players where player_id = $1`,
      [playerId],
    ),
  ]);

  const data: BadgeData = {
    sessions: sessionsResult.rows.map((row) => ({
      campaignId: row.campaign_id,
      status: row.status,
      endingId: row.ending_id,
      stepCount: row.step_count,
      attemptCounter: row.attempt_counter,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      kindId: row.kind_id,
    })),
    achievements: achievementsResult.rows.map((row) => ({
      campaignId: row.campaign_id,
      achievementId: row.achievement_id,
    })),
    mergeCount: playerResult.rows[0]?.merge_count ?? 0,
    catalogKindIds: new Set(demo.all.map((c) => c.kindId)),
    endingTotalOf: (campaignId) =>
      demo.findCampaign(campaignId)?.endingCount ?? 0,
    now: Date.now(),
  };

  const earned = BADGES.filter((b) => b.test(data)).map((b) => b.id);

  if (earned.length > 0) {
    await pool.query(
      `insert into badges (player_id, badge_id)
       select $1, unnest($2::text[])
       on conflict (player_id, badge_id) do nothing`,
      [playerId, earned],
    );
  }

  const { rows } = await pool.query<{ badge_id: string; unlocked_at: Date }>(
    `select badge_id, unlocked_at from badges where player_id = $1 order by unlocked_at`,
    [playerId],
  );
  return rows.map((row) => ({
    badgeId: row.badge_id,
    unlockedAt: row.unlocked_at.toISOString(),
  }));
}
