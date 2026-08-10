/**
 * Badge evaluation. Stored, not computed per request (same posture as the achievements
 * table, 004): `GET /api/badges` (routes/badges.ts) re-evaluates and upserts on every
 * call, so `unlocked_at` records the first request after a badge was actually earned, not
 * some later moment it happened to be displayed.
 *
 * Deliberately three-to-six queries and thirty-nine in-memory predicates rather than
 * thirty-nine SQL predicates -- a player's whole session history is a few dozen rows at
 * most, and keeping every rule as a readable JS function next to the assumption it
 * depends on matters more here than SQL purity. The three cross-player queries
 * (`platform-baselines.ts`) are the exception to "a few dozen rows" -- see their own
 * header comment.
 *
 * Time handling is UTC-only, on purpose. `sessions.created_at`/`updated_at` are ISO-8601
 * strings written by JS `Date.toISOString()` (server/src/persistence.ts) -- there is no
 * player timezone stored anywhere, so "3am" and "seven days in a row" mean 3am UTC and
 * seven UTC calendar days. Not a bug to fix later without a schema change.
 */
import type { Pool } from "pg";
import type { ServerDemo } from "./composition.js";
import {
  endingMedianSteps,
  rejectedPercentileFor,
  totalPlayerCount,
} from "./platform-baselines.js";
import { CROWN_BADGE_ID, currentLeaderPlayerId } from "./ranking.js";

export interface BadgeRow {
  readonly badgeId: string;
  readonly unlockedAt: string;
}

export interface SessionFacts {
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
  /** `actionLog[].actionId`, in order -- only `muscle-memory`/`the-long-way-around` read
   *  this. Extracted in JS from the full `blob`, not a SQL projection: `kindId` alone is
   *  cheap to pull with `->>`, but the action log needs the whole JSON parsed anyway. */
  readonly actionIds: readonly string[];
}

interface BadgeData {
  readonly sessions: readonly SessionFacts[];
  readonly achievements: readonly {
    campaignId: string;
    achievementId: string;
  }[];
  readonly mergeCount: number;
  readonly catalogKindIds: ReadonlySet<string>;
  /** Hidden-filtered catalog size -- `demo.catalog.length`, matching the denominator
   *  `PlayerHome`/`PlatformStats` already use, not `demo.all.length`. */
  readonly catalogSize: number;
  endingTotalOf(campaignId: string): number;
  readonly now: number;
  /** key: `${campaignId}:${endingId}`. Cross-player (platform-baselines.ts) -- only
   *  fetched when evaluateBadges runs for the owner; never for a public profile view. */
  readonly endingMedianSteps: ReadonlyMap<string, number>;
  /** This player's percent_rank (0-1) among every player's summed rejected-move proxy.
   *  Cross-player, same fetch scope as endingMedianSteps. */
  readonly rejectedPercentile: number;
  /** Total registered players -- gates `top-1-percent` so it isn't trivially true on a
   *  tiny userbase. */
  readonly totalPlayers: number;
  /** Whether this player currently holds the ranking's #1 spot (`ranking.ts`'s crown
   *  predicate). Cross-player, same fetch scope as the other three above -- and, unlike
   *  them, only public profiles can ever be true here, since the ranking only ranks
   *  `profile_public = true` players in the first place. */
  readonly isCurrentLeader: boolean;
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
const PERFECT_ATTENDANCE_DAYS = 30;
const DAY_MS = 86_400_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const SEASONED_CAMPAIGNS = 5;
const COLLECTOR_CAMPAIGNS = 3;
const ONE_JOB_SESSIONS = 10;
const BLACKOUT_CAMPAIGNS = 3;
const GROUNDHOG_SESSIONS = 10;
const SPECIALIST_MIN_ENDED = 5;
const SPECIALIST_SHARE = 0.9;
const TOURIST_MAX_FINISH_RATE = 0.5;
const EMPLOYEE_OF_THE_MONTH_STEPS = 2000;
const PRODUCTIVE_SUNDAY_STEPS = 300;
const MEDICAL_ADVICE_STEPS = 800;
const UNREASONABLY_EFFICIENT_CAMPAIGNS = 3;
const PERSISTENCE_FAILED_SESSIONS = 5;
const CREATURE_OF_HABIT_DAYS = 7;
const DISK_JOCKEY_CAMPAIGNS = 5;
const MUSCLE_MEMORY_SESSIONS = 3;
const MUSCLE_MEMORY_PREFIX = 3;
const SCENIC_ROUTE_MULTIPLIER = 2;
const SEQUENCE_BREAKER_DIVISOR = 2;
const TOP_PERCENT_THRESHOLD = 0.99;
const TOP_PERCENT_MIN_PLAYERS = 20;

function hourUtc(iso: string): number {
  return new Date(iso).getUTCHours();
}

function dayUtc(iso: string): string {
  return iso.slice(0, 10);
}

function monthUtc(iso: string): string {
  return iso.slice(0, 7);
}

/** UTC day-of-week for an ISO string, 0 = Sunday. */
function isUtcSunday(iso: string): boolean {
  return new Date(iso).getUTCDay() === 0;
}

function distinct<T>(values: Iterable<T>): Set<T> {
  return new Set(values);
}

/** The length of the longest run of consecutive calendar dates (UTC, `YYYY-MM-DD`
 *  strings) in `dates`. Shared by the `streak`/`perfect-attendance` badge predicates
 *  and `records.ts`'s `longestStreak` field -- one gaps-and-islands implementation. */
export function longestConsecutiveRun(dates: ReadonlySet<string>): number {
  const sorted = [...dates].sort();
  if (sorted.length === 0) return 0;
  let run = 1;
  let best = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = Date.parse(sorted[i]) - Date.parse(sorted[i - 1]);
    run = gap === DAY_MS ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

function hasConsecutiveRun(dates: ReadonlySet<string>, days: number): boolean {
  return longestConsecutiveRun(dates) >= days;
}

/** Every date (UTC) either timestamp of a session touches. */
function touchDates(sessions: readonly SessionFacts[]): Set<string> {
  const dates = new Set<string>();
  for (const s of sessions) {
    dates.add(dayUtc(s.createdAt));
    dates.add(dayUtc(s.updatedAt));
  }
  return dates;
}

/** Sums `stepCount` per UTC calendar date across both `createdAt` and `updatedAt` would
 *  double count -- a session's steps are attributed to the date it was *last* touched
 *  (`updatedAt`), which is the date the moves actually happened by, since `createdAt`
 *  for a still-open session is just when it started. */
function stepsByUtcDate(
  sessions: readonly SessionFacts[],
): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const s of sessions) {
    const date = dayUtc(s.updatedAt);
    byDate.set(date, (byDate.get(date) ?? 0) + s.stepCount);
  }
  return byDate;
}

function actionIdsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, i) => id === b[i]);
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
    test: (d) => hasConsecutiveRun(touchDates(d.sessions), STREAK_DAYS),
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

  // -- Codewars-inspired expansion (issue #19 follow-up) -------------------------------

  {
    id: "brute-force",
    test: (d) =>
      d.sessions.some(
        (s) => s.status === "ended" && s.attemptCounter > s.stepCount * 5 + 10,
      ),
  },
  {
    id: "speedrun-technically",
    test: (d) =>
      d.sessions.some((s) => s.status === "ended" && s.stepCount <= 5),
  },
  {
    id: "groundhog-day",
    test: (d) => {
      const counts = new Map<string, number>();
      for (const s of d.sessions) {
        if (s.status !== "ended") continue;
        counts.set(s.campaignId, (counts.get(s.campaignId) ?? 0) + 1);
      }
      return [...counts.values()].some((n) => n >= GROUNDHOG_SESSIONS);
    },
  },
  {
    id: "specialist",
    test: (d) => {
      const ended = d.sessions.filter((s) => s.status === "ended");
      if (ended.length < SPECIALIST_MIN_ENDED) return false;
      const counts = new Map<string, number>();
      for (const s of ended) {
        counts.set(s.campaignId, (counts.get(s.campaignId) ?? 0) + 1);
      }
      const max = Math.max(...counts.values());
      return max / ended.length >= SPECIALIST_SHARE;
    },
  },
  {
    id: "generalist",
    test: (d) => {
      if (d.catalogKindIds.size === 0) return false;
      const finishedKinds = distinct(
        d.sessions
          .filter((s) => s.status === "ended")
          .map((s) => s.kindId)
          .filter((k): k is string => k !== null),
      );
      for (const kind of d.catalogKindIds) {
        if (!finishedKinds.has(kind)) return false;
      }
      return true;
    },
  },
  {
    id: "tourist",
    test: (d) => {
      const touched = distinct(d.sessions.map((s) => s.campaignId));
      if (touched.size === 0 || touched.size !== d.catalogSize) return false;
      const finished = distinct(
        d.sessions.filter((s) => s.status === "ended").map((s) => s.campaignId),
      );
      return finished.size / touched.size < TOURIST_MAX_FINISH_RATE;
    },
  },
  {
    id: "perfect-attendance",
    test: (d) =>
      hasConsecutiveRun(touchDates(d.sessions), PERFECT_ATTENDANCE_DAYS),
  },
  {
    id: "employee-of-the-month",
    test: (d) => {
      const byMonth = new Map<string, number>();
      for (const s of d.sessions) {
        const month = monthUtc(s.updatedAt);
        byMonth.set(month, (byMonth.get(month) ?? 0) + s.stepCount);
      }
      return [...byMonth.values()].some(
        (n) => n >= EMPLOYEE_OF_THE_MONTH_STEPS,
      );
    },
  },
  {
    id: "productive-sunday",
    test: (d) => {
      const byDate = stepsByUtcDate(
        d.sessions.filter((s) => isUtcSunday(s.updatedAt)),
      );
      return [...byDate.values()].some((n) => n >= PRODUCTIVE_SUNDAY_STEPS);
    },
  },
  {
    id: "against-medical-advice",
    test: (d) => {
      const byDate = stepsByUtcDate(d.sessions);
      return [...byDate.values()].some((n) => n >= MEDICAL_ADVICE_STEPS);
    },
  },
  {
    id: "unreasonably-efficient",
    test: (d) => {
      const efficient = distinct(
        d.sessions
          .filter(
            (s) => s.status === "ended" && s.attemptCounter - s.stepCount <= 1,
          )
          .map((s) => s.campaignId),
      );
      return efficient.size >= UNREASONABLY_EFFICIENT_CAMPAIGNS;
    },
  },
  {
    id: "persistence-is-a-character-flaw",
    test: (d) => {
      const failed = new Map<string, number>();
      const ended = new Set<string>();
      for (const s of d.sessions) {
        if (s.status === "ended") ended.add(s.campaignId);
        else failed.set(s.campaignId, (failed.get(s.campaignId) ?? 0) + 1);
      }
      for (const [campaignId, count] of failed) {
        if (count >= PERSISTENCE_FAILED_SESSIONS && ended.has(campaignId))
          return true;
      }
      return false;
    },
  },
  {
    id: "one-more-turn",
    test: (d) => {
      const sorted = [...d.sessions].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      );
      for (const finished of d.sessions) {
        if (finished.status !== "ended") continue;
        const finishedAt = Date.parse(finished.updatedAt);
        for (const next of sorted) {
          if (next === finished) continue;
          const gap = Date.parse(next.createdAt) - finishedAt;
          if (gap >= 0 && gap <= FIVE_MINUTES_MS) return true;
        }
      }
      return false;
    },
  },
  {
    id: "immediate-regret",
    test: (d) => {
      for (const finished of d.sessions) {
        if (finished.status !== "ended") continue;
        const finishedAt = Date.parse(finished.updatedAt);
        for (const next of d.sessions) {
          if (next === finished || next.campaignId !== finished.campaignId)
            continue;
          const gap = Date.parse(next.createdAt) - finishedAt;
          if (gap >= 0 && gap <= FIVE_MINUTES_MS) return true;
        }
      }
      return false;
    },
  },
  {
    id: "creature-of-habit",
    test: (d) => {
      const byCampaignHour = new Map<string, Set<string>>();
      for (const s of d.sessions) {
        const key = `${s.campaignId}:${hourUtc(s.updatedAt)}`;
        const dates = byCampaignHour.get(key) ?? new Set<string>();
        dates.add(dayUtc(s.updatedAt));
        byCampaignHour.set(key, dates);
      }
      return [...byCampaignHour.values()].some(
        (dates) => dates.size >= CREATURE_OF_HABIT_DAYS,
      );
    },
  },
  {
    id: "disk-jockey",
    test: (d) => {
      const byDate = new Map<string, Set<string>>();
      for (const s of d.sessions) {
        const date = dayUtc(s.updatedAt);
        const campaigns = byDate.get(date) ?? new Set<string>();
        campaigns.add(s.campaignId);
        byDate.set(date, campaigns);
      }
      return [...byDate.values()].some(
        (campaigns) => campaigns.size >= DISK_JOCKEY_CAMPAIGNS,
      );
    },
  },
  {
    id: "muscle-memory",
    test: (d) => {
      const byCampaign = new Map<string, string[][]>();
      for (const s of d.sessions) {
        if (s.actionIds.length < MUSCLE_MEMORY_PREFIX) continue;
        const prefixes = byCampaign.get(s.campaignId) ?? [];
        prefixes.push(s.actionIds.slice(0, MUSCLE_MEMORY_PREFIX));
        byCampaign.set(s.campaignId, prefixes);
      }
      for (const prefixes of byCampaign.values()) {
        if (prefixes.length < MUSCLE_MEMORY_SESSIONS) continue;
        for (let i = 0; i < prefixes.length; i++) {
          const matches = prefixes.filter((p) =>
            actionIdsEqual(p, prefixes[i]!),
          );
          if (matches.length >= MUSCLE_MEMORY_SESSIONS) return true;
        }
      }
      return false;
    },
  },
  {
    id: "the-long-way-around",
    test: (d) => {
      const byEnding = new Map<string, string[][]>();
      for (const s of d.sessions) {
        if (!s.endingId) continue;
        const key = `${s.campaignId}:${s.endingId}`;
        const seqs = byEnding.get(key) ?? [];
        seqs.push([...s.actionIds]);
        byEnding.set(key, seqs);
      }
      for (const seqs of byEnding.values()) {
        for (let i = 0; i < seqs.length; i++) {
          for (let j = i + 1; j < seqs.length; j++) {
            if (!actionIdsEqual(seqs[i]!, seqs[j]!)) return true;
          }
        }
      }
      return false;
    },
  },
  {
    id: "scenic-route",
    test: (d) =>
      d.sessions.some((s) => {
        if (s.status !== "ended" || !s.endingId) return false;
        const median = d.endingMedianSteps.get(`${s.campaignId}:${s.endingId}`);
        return (
          median !== undefined &&
          median > 0 &&
          s.stepCount >= median * SCENIC_ROUTE_MULTIPLIER
        );
      }),
  },
  {
    id: "sequence-breaker",
    test: (d) =>
      d.sessions.some((s) => {
        if (s.status !== "ended" || !s.endingId) return false;
        const median = d.endingMedianSteps.get(`${s.campaignId}:${s.endingId}`);
        return (
          median !== undefined &&
          median > 0 &&
          s.stepCount <= median / SEQUENCE_BREAKER_DIVISOR
        );
      }),
  },
  {
    id: "top-1-percent",
    test: (d) =>
      d.totalPlayers >= TOP_PERCENT_MIN_PLAYERS &&
      d.rejectedPercentile >= TOP_PERCENT_THRESHOLD,
  },

  // -- Ranking crown (issue #19 follow-up) ---------------------------------------------

  {
    id: CROWN_BADGE_ID,
    test: (d) => d.isCurrentLeader,
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
  blob: string;
}

interface AchievementRow {
  campaign_id: string;
  achievement_id: string;
}

interface ParsedBlob {
  readonly kindId?: string;
  readonly actionLog?: readonly { readonly actionId?: string }[];
}

function parseSessionBlob(blob: string): {
  kindId: string | null;
  actionIds: readonly string[];
} {
  try {
    const parsed = JSON.parse(blob) as ParsedBlob;
    return {
      kindId: typeof parsed.kindId === "string" ? parsed.kindId : null,
      actionIds: (parsed.actionLog ?? [])
        .map((a) => a.actionId)
        .filter((id): id is string => typeof id === "string"),
    };
  } catch {
    return { kindId: null, actionIds: [] };
  }
}

export async function evaluateBadges(
  pool: Pool,
  demo: ServerDemo,
  playerId: string,
): Promise<BadgeRow[]> {
  const [
    sessionsResult,
    achievementsResult,
    playerResult,
    medians,
    percentile,
    playerCount,
    leaderId,
  ] = await Promise.all([
    pool.query<SessionRow>(
      `select campaign_id, status, ending_id, step_count, attempt_counter,
              created_at, updated_at, blob
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
    endingMedianSteps(pool),
    rejectedPercentileFor(pool, playerId),
    totalPlayerCount(pool),
    currentLeaderPlayerId(pool),
  ]);

  const data: BadgeData = {
    sessions: sessionsResult.rows.map((row) => {
      const { kindId, actionIds } = parseSessionBlob(row.blob);
      return {
        campaignId: row.campaign_id,
        status: row.status,
        endingId: row.ending_id,
        stepCount: row.step_count,
        attemptCounter: row.attempt_counter,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        kindId,
        actionIds,
      };
    }),
    achievements: achievementsResult.rows.map((row) => ({
      campaignId: row.campaign_id,
      achievementId: row.achievement_id,
    })),
    mergeCount: playerResult.rows[0]?.merge_count ?? 0,
    catalogKindIds: new Set(demo.all.map((c) => c.kindId)),
    catalogSize: demo.catalog.length,
    endingTotalOf: (campaignId) =>
      demo.findCampaign(campaignId)?.endingCount ?? 0,
    now: Date.now(),
    endingMedianSteps: medians,
    rejectedPercentile: percentile,
    totalPlayers: playerCount,
    isCurrentLeader: leaderId === playerId,
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
