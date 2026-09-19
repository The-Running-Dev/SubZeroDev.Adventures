import { request } from "../api/client";
/**
 * The account chip's data: `/api/me`, sign-in/out, `/api/progress`, `/api/badges`, and the
 * public `/api/stats` -- everything PlayApp.tsx needs to show "guest vs signed in",
 * per-campaign progress, cross-campaign badges, and platform-wide numbers. All but
 * `usePlatformStats` are per-player and only ever used in remote mode (`BrowserDemo.apiUrl`
 * set); there is nothing for any of these to fetch against the local, in-browser store.
 */
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "../app/providers/AccountProvider";
import { getIdentity, getAdminAccess } from "../api/identity";
import { getProgress, getBadges } from "../api/progress";
import { getPlatformStats } from "../api/stats";
import { getProfileSettings, setProfileVisibility } from "../api/profile";

export interface Identity {
  readonly playerId: string | null;
  readonly kind: "anonymous" | "guest" | "member";
  readonly displayName: string | null;
  /** The name `/api/auth/:provider/start` is actually registered under on this deployment
   *  (server's `identity/registry.ts`), or `null` when nothing is configured. Read from the
   *  server rather than assumed here, so a deployment's `OIDC_PROVIDER_NAME` can never
   *  disagree with the URL a player is sent to -- issue #16. */
  readonly signInProvider: string | null;
}

export interface CampaignProgress {
  readonly campaignId: string;
  readonly status: string;
  readonly stepCount: number;
  readonly sessionCount: number;
  readonly firstPlayedAt: string;
  readonly lastPlayedAt: string;
  readonly endings: {
    readonly discovered: readonly string[];
    readonly total: number;
  };
  readonly achievements: readonly string[];
}

export interface Badge {
  readonly badgeId: string;
  readonly unlockedAt: string;
}

export interface PlatformStats {
  readonly players: number;
  readonly sessions: number;
  readonly sessionsFinished: number;
  readonly campaignsPlayed: number;
  readonly stepsTaken: number;
  readonly achievementsUnlocked: number;
  readonly badgesUnlocked: number;
}

/** "Personnel File" -- pure aggregates over a player's own session history, plus one
 *  cross-player field (`rarestEnding`). Mirrors server/src/records.ts's shape exactly. */
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

export interface ProfileSettings {
  readonly public: boolean;
  readonly slug: string | null;
}

// Named PublicProfileData, not PublicProfile -- src/profile/PublicProfile.tsx's
// component export would otherwise collide with this type's name.
export interface PublicProfileData {
  readonly displayName: string;
  readonly joinedAt: string;
  readonly sessionsStarted: number;
  readonly sessionsFinished: number;
  readonly campaignsPlayed: number;
  readonly campaignsTotal: number;
  readonly stepsTaken: number;
  readonly endingsFound: number;
  readonly achievementsUnlocked: number;
  readonly badges: readonly Badge[];
  readonly records: PersonnelRecords;
}

/** One row of `GET /api/ranking` -- mirrors `server/src/ranking.ts`'s
 *  `PublicLeaderboardEntry` exactly. `badgeCount` here is already the play-earned count
 *  (the server excludes the crown before this ever leaves it), so it needs no
 *  `playEarnedBadgeCount` pass on the client the way a raw `Badge[]` list would. */
export interface RankingEntry {
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

export interface RankingData {
  readonly entries: readonly RankingEntry[];
  readonly totalRanked: number;
}

/** One row of `GET /api/discussions`, and the shape `POST /api/discussions` echoes back
 *  for the thread it just created -- mirrors `server/src/routes/discussions.ts`'s
 *  `threadEntry` exactly. `authorKind` is `"player"` when a local SubZeroDev session
 *  wrote it (name already resolved server-side through `maskDisplayName`) and `"forum"`
 *  when it did not -- there is nothing for this page to compute from that beyond which
 *  label to show. */
export interface DiscussionSummaryData {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly authorName: string;
  readonly authorKind: "player" | "forum";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commentCount: number;
  readonly url: string;
}

export interface DiscussionCommentData {
  readonly id: string;
  readonly body: string;
  readonly authorName: string;
  readonly createdAt: string;
  readonly url: string;
}

// Named DiscussionListData, not DiscussionList -- src/discussions/Discussions.tsx's
// component export would otherwise collide with this type's name, the same reason
// PublicProfileData is named the way it is above.
export interface DiscussionListData {
  readonly configured: boolean;
  readonly forum: string;
  readonly canPost: boolean;
  readonly threads: readonly DiscussionSummaryData[];
  readonly nextCursor?: string;
}

export interface DiscussionThreadData {
  readonly configured: boolean;
  readonly forum: string;
  readonly canPost: boolean;
  readonly thread: DiscussionSummaryData;
  readonly body: string;
  readonly comments: readonly DiscussionCommentData[];
  readonly moreComments: boolean;
}

export const anonymousIdentity: Identity = {
  playerId: null,
  kind: "anonymous",
  displayName: null,
  signInProvider: null,
};

export function useIdentity(apiUrl: string | undefined, refreshToken: number) {
  const query = useQuery({
    queryKey: ["identity", apiUrl, refreshToken],
    // Retain one in-flight bootstrap through StrictMode's effect replay.
    queryFn: () => getIdentity(apiUrl),
    enabled: Boolean(apiUrl),
    staleTime: Infinity,
  });
  return {
    identity: query.data ?? anonymousIdentity,
    loading: Boolean(apiUrl) && query.isPending,
    error: query.error,
  };
}

export function useAdminAccess(
  apiUrl: string | undefined,
  playerId: string | null,
  refreshToken = 0,
) {
  const query = useQuery({
    queryKey: ["private", apiUrl, playerId, refreshToken, "admin"],
    queryFn: ({ signal }) => getAdminAccess(apiUrl, signal),
    enabled: Boolean(apiUrl && playerId),
  });
  return {
    isAdmin: query.data?.isAdmin === true,
    loading: Boolean(apiUrl && playerId) && query.isPending,
  };
}

export function useProgress(
  apiUrl: string | undefined,
  playerId: string | null,
): ReadonlyMap<string, CampaignProgress> {
  const { refreshToken, loading } = useAccount();
  const query = useQuery({
    queryKey: ["private", apiUrl, playerId, refreshToken, "progress"],
    queryFn: ({ signal }) => getProgress(apiUrl, signal),
    enabled: Boolean(apiUrl && playerId) && !loading,
  });
  return useMemo(
    () => new Map(query.data?.progress.map((p) => [p.campaignId, p]) ?? []),
    [query.data],
  );
}

export function useBadges(
  apiUrl: string | undefined,
  playerId: string | null,
): { badges: readonly Badge[]; records: PersonnelRecords | null } {
  const { refreshToken, loading } = useAccount();
  const query = useQuery({
    queryKey: ["private", apiUrl, playerId, refreshToken, "badges"],
    queryFn: ({ signal }) => getBadges(apiUrl, signal),
    enabled: Boolean(apiUrl && playerId) && !loading,
  });
  return {
    badges: query.data?.badges ?? [],
    records: query.data?.records ?? null,
  };
}

export function usePlatformStats(
  apiUrl: string | undefined,
): PlatformStats | null {
  const query = useQuery({
    queryKey: ["public", apiUrl, "stats"],
    queryFn: ({ signal }) => getPlatformStats(apiUrl, signal),
    enabled: Boolean(apiUrl),
  });
  return query.data ?? null;
}

export function useProfileSettings(
  apiUrl: string | undefined,
  playerId: string | null,
  refreshToken: number,
) {
  const client = useQueryClient();
  const queryKey = [
    "private",
    apiUrl,
    playerId,
    refreshToken,
    "profile-settings",
  ];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getProfileSettings(apiUrl, signal),
    enabled: Boolean(apiUrl && playerId),
  });
  async function setPublic(next: boolean) {
    const settings = await setProfileVisibility(apiUrl, next);
    // An account transition removes the old query; a late mutation cannot restore it.
    if (client.getQueryState(queryKey)) client.setQueryData(queryKey, settings);
  }
  return {
    settings: query.data ?? { public: false, slug: null },
    error: query.error,
    retry: () => {
      void query.refetch();
    },
    loading: Boolean(apiUrl && playerId) && query.isPending,
    setPublic,
  };
}

/** Builds the sign-in link for whichever provider `/api/me` reported as configured
 *  (`Identity.signInProvider`). Callers should check that field is non-null first, so the
 *  link never points somewhere that can only redirect back with `oauth_not_configured`. */
export function signInUrl(apiUrl: string, provider: string): string {
  return `${apiUrl}/api/auth/${provider}/start`;
}

export async function signOut(apiUrl: string): Promise<void> {
  await request(apiUrl, "/api/auth/logout", { method: "POST" });
}

/** Reads and strips `?auth_error=` left by a failed OAuth round trip
 *  (server/src/routes/identity.ts's `redirectWithError`) -- read once, then cleaned
 *  from the URL so a refresh doesn't keep re-showing it. */
export function consumeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("auth_error");
  if (!code) return null;
  url.searchParams.delete("auth_error");
  window.history.replaceState(window.history.state, "", url.toString());
  return code;
}
