/**
 * "Personnel File" -- pure aggregate stats over a player's own session history, plus one
 * cross-player field (`rarestEnding`). Unlike badges, records are never stored: nothing
 * here needs `unlocked_at` or an upsert, so the same function serves both the owner's own
 * "Your record" view and a public profile visitor with no special-casing and no
 * staleness question (contrast `badges.ts`'s header comment).
 */
import type { Pool } from "pg";
import { longestConsecutiveRun } from "./badges.js";
import { discovererCounts } from "./platform-baselines.js";

export interface PersonnelRecords {
  readonly longestRun: number;
  readonly longestStreak: number;
  readonly mostMovesInADay: number;
  readonly favoriteDisk: {
    readonly campaignId: string;
    readonly sessions: number;
  } | null;
  readonly mostRejectedMoves: number;
  readonly fastestEnding: number | null;
  readonly rarestEnding: {
    readonly campaignId: string;
    readonly endingId: string;
    readonly discoverers: number;
  } | null;
  readonly completionRate: number;
  readonly attemptEfficiency: number;
}

interface RecordSessionRow {
  campaign_id: string;
  status: string;
  ending_id: string | null;
  step_count: number;
  attempt_counter: number;
  created_at: string;
  updated_at: string;
}

function dayUtc(iso: string): string {
  return iso.slice(0, 10);
}

export async function computeRecords(
  pool: Pool,
  playerId: string,
  excludedCampaignIds: readonly string[],
): Promise<PersonnelRecords> {
  const [sessionsResult, discoverers] = await Promise.all([
    pool.query<RecordSessionRow>(
      `select campaign_id, status, ending_id, step_count, attempt_counter,
              created_at, updated_at
         from sessions where profile_id = $1`,
      [playerId],
    ),
    // Submission-tier campaigns excluded -- see this function's own
    // `discoverers.get(key) === undefined` check below, which is what keeps a private
    // submission's ending from trivially winning `rarestEnding` (it would otherwise
    // always have exactly one discoverer: its own author).
    discovererCounts(pool, excludedCampaignIds),
  ]);
  const sessions = sessionsResult.rows;

  if (sessions.length === 0) {
    return {
      longestRun: 0,
      longestStreak: 0,
      mostMovesInADay: 0,
      favoriteDisk: null,
      mostRejectedMoves: 0,
      fastestEnding: null,
      rarestEnding: null,
      completionRate: 0,
      attemptEfficiency: 0,
    };
  }

  const longestRun = Math.max(...sessions.map((s) => s.step_count));

  const touchDates = new Set<string>();
  const stepsByDate = new Map<string, number>();
  for (const s of sessions) {
    touchDates.add(dayUtc(s.created_at));
    touchDates.add(dayUtc(s.updated_at));
    const date = dayUtc(s.updated_at);
    stepsByDate.set(date, (stepsByDate.get(date) ?? 0) + s.step_count);
  }
  const longestStreak = longestConsecutiveRun(touchDates);
  const mostMovesInADay = Math.max(...stepsByDate.values());

  const sessionsByCampaign = new Map<string, number>();
  for (const s of sessions) {
    sessionsByCampaign.set(
      s.campaign_id,
      (sessionsByCampaign.get(s.campaign_id) ?? 0) + 1,
    );
  }
  let favoriteDisk: PersonnelRecords["favoriteDisk"] = null;
  for (const [campaignId, count] of sessionsByCampaign) {
    if (!favoriteDisk || count > favoriteDisk.sessions) {
      favoriteDisk = { campaignId, sessions: count };
    }
  }

  const mostRejectedMoves = Math.max(
    0,
    ...sessions.map((s) => s.attempt_counter - s.step_count),
  );

  const endedWithEnding = sessions.filter(
    (s) => s.status === "ended" && s.ending_id !== null,
  );
  const fastestEnding =
    endedWithEnding.length > 0
      ? Math.min(...endedWithEnding.map((s) => s.step_count))
      : null;

  let rarestEnding: PersonnelRecords["rarestEnding"] = null;
  for (const s of endedWithEnding) {
    const key = `${s.campaign_id}:${s.ending_id}`;
    const count = discoverers.get(key);
    if (count === undefined) continue;
    if (!rarestEnding || count < rarestEnding.discoverers) {
      rarestEnding = {
        campaignId: s.campaign_id,
        endingId: s.ending_id!,
        discoverers: count,
      };
    }
  }

  const endedCount = sessions.filter((s) => s.status === "ended").length;
  const completionRate = endedCount / sessions.length;

  const totalSteps = sessions.reduce((sum, s) => sum + s.step_count, 0);
  const totalAttempts = sessions.reduce((sum, s) => sum + s.attempt_counter, 0);
  const attemptEfficiency = totalAttempts > 0 ? totalSteps / totalAttempts : 0;

  return {
    longestRun,
    longestStreak,
    mostMovesInADay,
    favoriteDisk,
    mostRejectedMoves,
    fastestEnding,
    rarestEnding,
    completionRate,
    attemptEfficiency,
  };
}
