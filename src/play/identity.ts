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
 *  sign-in or transfer merges in a new set, and a no-op returning `[]` in local mode
 *  where `apiUrl` is undefined -- there is no server to evaluate badges against. */
export function useBadges(
  apiUrl: string | undefined,
  playerId: string | null,
): readonly Badge[] {
  const [badges, setBadges] = useState<readonly Badge[]>([]);

  useEffect(() => {
    if (!apiUrl || !playerId) {
      setBadges([]);
      return;
    }
    let cancelled = false;
    fetch(`${apiUrl}/api/badges`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : { badges: [] }))
      .then((body: { badges: Badge[] }) => {
        if (!cancelled) setBadges(body.badges);
      })
      .catch(() => {
        if (!cancelled) setBadges([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, playerId]);

  return badges;
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
