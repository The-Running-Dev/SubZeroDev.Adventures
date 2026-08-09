/**
 * The account chip's data: `/api/me`, GitHub sign-in/out, and `/api/progress` --
 * everything PlayApp.tsx needs to show "guest vs signed in" and per-campaign progress.
 * Only ever used in remote mode (`BrowserDemo.apiUrl` set); there is nothing for these to
 * fetch against the local, in-browser store.
 */
import { useEffect, useState } from "react";

export interface Identity {
  readonly playerId: string | null;
  readonly kind: "anonymous" | "guest" | "member";
  readonly displayName: string | null;
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

const anonymousIdentity: Identity = {
  playerId: null,
  kind: "anonymous",
  displayName: null,
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

export function githubSignInUrl(apiUrl: string): string {
  return `${apiUrl}/api/auth/github/start`;
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
