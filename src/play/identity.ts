/**
 * The account chip's data: `/api/me`, sign-in/out, `/api/progress`, `/api/badges`, and the
 * public `/api/stats` -- everything PlayApp.tsx needs to show "guest vs signed in",
 * per-campaign progress, cross-campaign badges, and platform-wide numbers. All but
 * `usePlatformStats` are per-player and only ever used in remote mode (`BrowserDemo.apiUrl`
 * set); there is nothing for any of these to fetch against the local, in-browser store.
 */
import { useEffect, useState } from "react";

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

const anonymousIdentity: Identity = {
  playerId: null,
  kind: "anonymous",
  displayName: null,
  signInProvider: null,
};

/** Fetches `/api/me` once on mount. `refreshToken` bumps to re-fetch after a sign-in/out
 *  round trip changes the cookie. `apiUrl` is `undefined` in local mode -- called
 *  unconditionally either way (rules of hooks), it just never fetches. */
export function useIdentity(
  apiUrl: string | undefined,
  refreshToken: number,
): { identity: Identity; loading: boolean } {
  const [identity, setIdentity] = useState<Identity>(anonymousIdentity);
  const [loading, setLoading] = useState(apiUrl !== undefined);

  useEffect(() => {
    if (!apiUrl) return;
    let cancelled = false;
    setLoading(true);
    fetch(`${apiUrl}/api/me`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : anonymousIdentity))
      .then((body: Identity) => {
        if (!cancelled) setIdentity(body);
      })
      .catch(() => {
        if (!cancelled) setIdentity(anonymousIdentity);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, refreshToken]);

  return { identity, loading };
}

/** Progress is keyed by campaignId; a campaign with no session yet simply has no entry.
 *  `apiUrl` is `undefined` in local mode -- called unconditionally either way, it just
 *  never fetches. */
export function useProgress(
  apiUrl: string | undefined,
  playerId: string | null,
): ReadonlyMap<string, CampaignProgress> {
  const [progress, setProgress] = useState<
    ReadonlyMap<string, CampaignProgress>
  >(new Map());

  useEffect(() => {
    if (!apiUrl || !playerId) {
      setProgress(new Map());
      return;
    }
    let cancelled = false;
    fetch(`${apiUrl}/api/progress`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : { progress: [] }))
      .then((body: { progress: CampaignProgress[] }) => {
        if (cancelled) return;
        setProgress(new Map(body.progress.map((p) => [p.campaignId, p])));
      })
      .catch(() => {
        if (!cancelled) setProgress(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, playerId]);

  return progress;
}

/** Mirrors `useProgress`'s shape exactly: keyed off `playerId` so it re-fetches after a
 *  sign-in or transfer merges in a new set, and a no-op returning `[]`/`null` in local
 *  mode where `apiUrl` is undefined -- there is no server to evaluate badges or compute
 *  records against. `records` is `null` before the fetch resolves and in local mode,
 *  same absent-state convention `usePlatformStats` already uses. */
export function useBadges(
  apiUrl: string | undefined,
  playerId: string | null,
): { badges: readonly Badge[]; records: PersonnelRecords | null } {
  const [badges, setBadges] = useState<readonly Badge[]>([]);
  const [records, setRecords] = useState<PersonnelRecords | null>(null);

  useEffect(() => {
    if (!apiUrl || !playerId) {
      setBadges([]);
      setRecords(null);
      return;
    }
    let cancelled = false;
    fetch(`${apiUrl}/api/badges`, { credentials: "include" })
      .then((response) =>
        response.ok ? response.json() : { badges: [], records: null },
      )
      .then((body: { badges: Badge[]; records: PersonnelRecords | null }) => {
        if (cancelled) return;
        setBadges(body.badges);
        setRecords(body.records);
      })
      .catch(() => {
        if (!cancelled) {
          setBadges([]);
          setRecords(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, playerId]);

  return { badges, records };
}

/** The one public read in this module -- `/api/stats` needs no cookie and no player, so
 *  no `credentials: "include"` (there's nothing for the server to read off it). Still
 *  no-ops when `apiUrl` is undefined: local mode has no backend at all (composition.ts),
 *  so there is nothing to fetch and the caller renders nothing. */
export function usePlatformStats(
  apiUrl: string | undefined,
): PlatformStats | null {
  const [stats, setStats] = useState<PlatformStats | null>(null);

  useEffect(() => {
    if (!apiUrl) {
      setStats(null);
      return;
    }
    let cancelled = false;
    fetch(`${apiUrl}/api/stats`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: PlatformStats | null) => {
        if (!cancelled) setStats(body);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  return stats;
}

const anonymousProfileSettings: ProfileSettings = { public: false, slug: null };

/** Mirrors `useIdentity`'s fetch-on-mount shape (GET `/api/profile/settings`, a no-op
 *  when `apiUrl`/`playerId` is absent), plus a `setPublic` action that POSTs
 *  `/api/profile/visibility` and updates local state from the response directly --
 *  no full-page refetch needed to see the new slug/flag. */
export function useProfileSettings(
  apiUrl: string | undefined,
  playerId: string | null,
  refreshToken: number,
): {
  settings: ProfileSettings;
  loading: boolean;
  setPublic: (next: boolean) => Promise<void>;
} {
  const [settings, setSettings] = useState<ProfileSettings>(
    anonymousProfileSettings,
  );
  const [loading, setLoading] = useState(Boolean(apiUrl && playerId));

  useEffect(() => {
    if (!apiUrl || !playerId) {
      setSettings(anonymousProfileSettings);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`${apiUrl}/api/profile/settings`, { credentials: "include" })
      .then((response) =>
        response.ok ? response.json() : anonymousProfileSettings,
      )
      .then((body: ProfileSettings) => {
        if (!cancelled) setSettings(body);
      })
      .catch(() => {
        if (!cancelled) setSettings(anonymousProfileSettings);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, playerId, refreshToken]);

  async function setPublic(next: boolean): Promise<void> {
    if (!apiUrl) return;
    const response = await fetch(`${apiUrl}/api/profile/visibility`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public: next }),
    });
    if (!response.ok) throw new Error("Couldn't update profile visibility.");
    const body = (await response.json()) as ProfileSettings;
    setSettings(body);
  }

  return { settings, loading, setPublic };
}

/** Builds the sign-in link for whichever provider `/api/me` reported as configured
 *  (`Identity.signInProvider`). Callers should check that field is non-null first, so the
 *  link never points somewhere that can only redirect back with `oauth_not_configured`. */
export function signInUrl(apiUrl: string, provider: string): string {
  return `${apiUrl}/api/auth/${provider}/start`;
}

export async function signOut(apiUrl: string): Promise<void> {
  await fetch(`${apiUrl}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

/** Reads and strips `?auth_error=` left by a failed OAuth round trip
 *  (server/src/routes/identity.ts's `redirectWithError`) -- read once, then cleaned
 *  from the URL so a refresh doesn't keep re-showing it. */
export function consumeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("auth_error");
  if (!code) return null;
  url.searchParams.delete("auth_error");
  window.history.replaceState({}, "", url.toString());
  return code;
}
