/**
 * The signed-in (or guest) player's own profile, reached via `/profile` (main.tsx's
 * routing) -- a standalone top-level view, same shape as `src/ranking/Ranking.tsx` and
 * `PublicProfile.tsx`: `apiUrl` read once by `main.tsx` and passed down as a prop, its
 * own theme state for the shared `Header`. Previously this was a shelf face inside
 * PlayApp.tsx's single-page app; it moved out so "Profile" could be a real, linkable,
 * bookmarkable page like the other two.
 *
 * The identity/progress/badges/settings fetches are the same hooks PlayApp.tsx used when
 * this lived there (identity.ts) -- nothing about *what* is fetched changed, only that
 * this page now fetches it for itself instead of receiving it as props.
 */
import { useEffect, useState } from "react";
import { Header } from "../Header";
import { AccountPanel } from "../play/AccountPanel";
import type { BrowserCampaign } from "../play/composition";
import {
  consumeAuthError,
  useBadges,
  useIdentity,
  useProfileSettings,
  useProgress,
} from "../play/identity";
import { PlayerHome } from "../play/PlayerHome";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
  type ThemeId,
} from "../theme";

interface CampaignsResponse {
  campaigns: readonly BrowserCampaign[];
}

/** The same `!hidden` filter composition.ts's `demo.catalog` applies, kept in sync here
 *  so "Stories finished x/N" means the same N this player would see on the shelf. */
function useCatalog(apiUrl: string | undefined): readonly BrowserCampaign[] {
  const [catalog, setCatalog] = useState<readonly BrowserCampaign[]>([]);

  useEffect(() => {
    if (!apiUrl) {
      setCatalog([]);
      return;
    }
    let cancelled = false;
    fetch(`${apiUrl}/api/campaigns`)
      .then((response) => (response.ok ? response.json() : { campaigns: [] }))
      .then((body: CampaignsResponse) => {
        if (!cancelled)
          setCatalog(body.campaigns.filter((campaign) => !campaign.hidden));
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  return catalog;
}

export function OwnProfile({ apiUrl }: { apiUrl?: string }) {
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);
  function changeTheme(id: ThemeId): void {
    setTheme(id);
    applyTheme(id);
    storeTheme(id);
  }

  const [identityRefreshToken, setIdentityRefreshToken] = useState(0);
  const { identity, loading: identityLoading } = useIdentity(
    apiUrl,
    identityRefreshToken,
  );
  const progress = useProgress(apiUrl, identity.playerId);
  const { badges, records } = useBadges(apiUrl, identity.playerId);
  const { settings, setPublic } = useProfileSettings(
    apiUrl,
    identity.playerId,
    identityRefreshToken,
  );
  const catalog = useCatalog(apiUrl);
  const [authError] = useState(() => consumeAuthError());

  const ready =
    Boolean(apiUrl) && !identityLoading && identity.kind !== "anonymous";

  return (
    <main className="play-main">
      <Header current="profile" theme={theme} onThemeChange={changeTheme}>
        {apiUrl && (
          <AccountPanel
            apiUrl={apiUrl}
            identity={identity}
            loading={identityLoading}
            authError={authError}
            onChanged={() => setIdentityRefreshToken((token) => token + 1)}
            // Already on the profile page -- the account menu's own link to it would be
            // redundant.
            profileAvailable={false}
          />
        )}
      </Header>
      <section className="archive" aria-labelledby="profile-title">
        <div className="archive-heading">
          <p className="eyebrow">SUBZERO STORY SYSTEM // OPERATOR RECORD</p>
          <h1 id="profile-title">Profile</h1>

          {!apiUrl && (
            <p className="profile-unavailable">
              Profiles aren't available on this build.
            </p>
          )}
          {apiUrl && identityLoading && (
            <p className="profile-unavailable" role="status">
              Loading your record…
            </p>
          )}
          {apiUrl && !identityLoading && identity.kind === "anonymous" && (
            <p className="profile-unavailable">
              Play a story or sign in first -- there's nothing on record yet.
            </p>
          )}
        </div>

        {ready && (
          <PlayerHome
            identity={identity}
            progress={progress}
            badges={badges}
            records={records}
            catalog={catalog}
            settings={settings}
            setPublic={setPublic}
          />
        )}
      </section>
    </main>
  );
}
