/**
 * The public leaderboard (issue #19 follow-up) -- ranks every player with
 * `profile_public = true` by a composite "Absurdity Index", and identifies whoever
 * currently sits at #1 for the crown (both the live badge on `/api/ranking` and the
 * permanent `CROWN_BADGE_ID` awarded via `badges.ts`).
 *
 * The formula, `absurdityIndexOf`, and the tie-break chain, `compareEntries`, are pure
 * and DB-free on purpose -- `platform-baselines.ts`'s `publicProfileTotals` does the one
 * query, and everything here is ordering arithmetic over its result, testable with no
 * Postgres. That query reads no `sessions` timestamp (those columns are TEXT, migration
 * 002) -- only `players.created_at` and `badges.unlocked_at`, both real `timestamptz` --
 * so the tie-break chain below never needs the JS date handling `badges.ts` uses.
 *
 * `attempt_counter` (feeding `rejected`) is dual-purposed as the optimistic-lock version
 * (`server/src/badges.ts`'s note on `SessionFacts.attemptCounter`) -- an approximate
 * proxy for rejected moves, not an exact count. A ranking has no threshold to loosen the
 * way a badge predicate does, so this is accepted and disclosed on the page itself
 * (the standings footnote, `src/ranking/Ranking.tsx`) rather than hidden.
 */
import type { Pool } from "pg";
import {
  publicProfileTotals,
  type PublicProfileTotal,
} from "./platform-baselines.js";
import { maskDisplayName } from "./display-name.js";

/** The 40th badge -- awarded to whoever currently sits at #1 (`evaluateBadges` in
 *  `badges.ts`). Excluded from every player's own `badge_count` below so that holding it
 *  can never raise the score that put them there in the first place. */
export const CROWN_BADGE_ID = "interim-head-of-absurdity";

const BADGE_WEIGHT = 100;
const REJECTED_WEIGHT = 5;
const ENDING_WEIGHT = 25;
const MOVES_DIVISOR = 10;

/** Same instinct as `badges.ts`'s `TOP_PERCENT_MIN_PLAYERS` -- "so it isn't trivially
 *  true on a tiny userbase" -- scaled down because opt-in public profiles are a much
 *  smaller population than `players` as a whole. */
export const CROWN_MIN_RANKED_PLAYERS = 3;

/** The response is capped, not the query -- ranking happens over every public profile
 *  and only the top slice is serialized. A SQL `LIMIT` applied before ranking would
 *  produce wrong positions. If the public set ever outgrows a full per-request scan, the
 *  fix is the periodically-refreshed materialized view `platform-baselines.ts` already
 *  names for its own scale concerns, not a query-level limit here. */
export const RANKING_LIMIT = 100;

interface AbsurdityInputs {
  readonly badgeCount: number;
  readonly rejected: number;
  readonly endings: number;
  readonly moves: number;
}

/** 100 per badge, 5 per rejected move, 25 per ending, 1 per ten moves -- badges lead
 *  because they're the one curated signal (39 hand-written predicates); rejected moves
 *  are weighted so an extreme total can still beat a badge-complete player, which is the
 *  right outcome for a board named "absurdity"; endings sit below a badge on purpose
 *  since several badges already key off endings; moves are the honest, rarely-decisive
 *  tail. Every term is non-negative, so the index is monotone -- playing more can never
 *  lower a score. `Math.floor`, not rounding, so the footnote's per-column arithmetic on
 *  the page always matches exactly. */
export function absurdityIndexOf(inputs: AbsurdityInputs): number {
  return (
    BADGE_WEIGHT * inputs.badgeCount +
    REJECTED_WEIGHT * inputs.rejected +
    ENDING_WEIGHT * inputs.endings +
    Math.floor(inputs.moves / MOVES_DIVISOR)
  );
}

interface ComparableTotal extends PublicProfileTotal {
  readonly absurdityIndex: number;
}

/** A total order, so exactly one player is ever #1. Index desc, then the curated axis
 *  (badges), then the joke axis (rejected moves), then raw moves, then seniority --
 *  earliest first badge, then earliest account, then `profileSlug` as the final,
 *  guaranteed-unique tiebreaker (`players.profile_slug` is `unique`). */
export function compareEntries(a: ComparableTotal, b: ComparableTotal): number {
  if (a.absurdityIndex !== b.absurdityIndex)
    return b.absurdityIndex - a.absurdityIndex;
  if (a.badgeCount !== b.badgeCount) return b.badgeCount - a.badgeCount;
  if (a.rejected !== b.rejected) return b.rejected - a.rejected;
  if (a.moves !== b.moves) return b.moves - a.moves;
  const aFirst = a.firstBadgeAtMs ?? Number.POSITIVE_INFINITY;
  const bFirst = b.firstBadgeAtMs ?? Number.POSITIVE_INFINITY;
  if (aFirst !== bFirst) return aFirst - bFirst;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  if (a.profileSlug !== b.profileSlug)
    return a.profileSlug < b.profileSlug ? -1 : 1;
  return 0;
}

/** One predicate for both the live crown (`RankedEntry.crowned` below) and the stored
 *  badge (`currentLeaderPlayerId`), so the two can never disagree: position 1, at least
 *  `CROWN_MIN_RANKED_PLAYERS` ranked, and an index above zero (nobody crowns a public
 *  profile that has done literally nothing). */
function isCrowned(
  position: number,
  totalRanked: number,
  absurdityIndex: number,
): boolean {
  return (
    position === 1 &&
    totalRanked >= CROWN_MIN_RANKED_PLAYERS &&
    absurdityIndex > 0
  );
}

export interface RankedEntry {
  readonly playerId: string;
  readonly profileSlug: string;
  readonly displayName: string | null;
  readonly position: number;
  readonly absurdityIndex: number;
  readonly badgeCount: number;
  readonly rejected: number;
  readonly endings: number;
  readonly moves: number;
  readonly crowned: boolean;
}

/** Pure: assigns `1..n` with no gaps or duplicates over whatever totals it's given.
 *  `playerId` stays on every entry here -- callers that expose this externally (the
 *  public route) must strip it; `currentLeaderPlayerId` is the one caller that needs it. */
export function rankProfiles(
  totals: readonly PublicProfileTotal[],
): readonly RankedEntry[] {
  const withIndex: ComparableTotal[] = totals.map((t) => ({
    ...t,
    absurdityIndex: absurdityIndexOf(t),
  }));
  const sorted = [...withIndex].sort(compareEntries);
  const totalRanked = sorted.length;
  return sorted.map((t, i) => {
    const position = i + 1;
    return {
      playerId: t.playerId,
      profileSlug: t.profileSlug,
      displayName: t.displayName,
      position,
      absurdityIndex: t.absurdityIndex,
      badgeCount: t.badgeCount,
      rejected: t.rejected,
      endings: t.endings,
      moves: t.moves,
      crowned: isCrowned(position, totalRanked, t.absurdityIndex),
    };
  });
}

export interface PublicLeaderboardEntry {
  readonly profileSlug: string;
  readonly displayName: string;
  readonly position: number;
  readonly absurdityIndex: number;
  readonly badgeCount: number;
  readonly rejected: number;
  readonly endings: number;
  readonly moves: number;
  readonly crowned: boolean;
}

/** `GET /api/ranking`'s one query plus the pure ranking above, with `playerId` stripped
 *  and `displayName` masked (`display-name.ts`) before anything leaves the server --
 *  `player_id` stays opaque outside `/api/me` (api.test.ts's standing invariant), and an
 *  email-shaped `display_name` never reaches a public response (`profile.test.ts`'s
 *  existing rule, reused rather than re-derived here). `totalRanked` is the full public
 *  population, independent of `RANKING_LIMIT`'s slice, so the crown gate and the page's
 *  own "too few public records" note read the true count. */
export async function computeLeaderboard(
  pool: Pool,
  coreCampaignIds: readonly string[],
): Promise<{
  readonly entries: readonly PublicLeaderboardEntry[];
  readonly totalRanked: number;
}> {
  const totals = await publicProfileTotals(
    pool,
    CROWN_BADGE_ID,
    coreCampaignIds,
  );
  const ranked = rankProfiles(totals);
  const entries = ranked
    .slice(0, RANKING_LIMIT)
    .map((r): PublicLeaderboardEntry => ({
      profileSlug: r.profileSlug,
      displayName: maskDisplayName(r.displayName),
      position: r.position,
      absurdityIndex: r.absurdityIndex,
      badgeCount: r.badgeCount,
      rejected: r.rejected,
      endings: r.endings,
      moves: r.moves,
      crowned: r.crowned,
    }));
  return { entries, totalRanked: ranked.length };
}

/** Raw `player_id` of whoever currently holds the crown, or `null` below the ranked-
 *  player floor -- consumed only by `evaluateBadges` (`badges.ts`) inside its own
 *  `Promise.all`, compared in memory, and never serialized. `GET /api/ranking` never
 *  calls this; the public route only ever sees `computeLeaderboard`'s slug-keyed shape. */
export async function currentLeaderPlayerId(
  pool: Pool,
  coreCampaignIds: readonly string[],
): Promise<string | null> {
  const totals = await publicProfileTotals(
    pool,
    CROWN_BADGE_ID,
    coreCampaignIds,
  );
  const ranked = rankProfiles(totals);
  return ranked.find((r) => r.crowned)?.playerId ?? null;
}
