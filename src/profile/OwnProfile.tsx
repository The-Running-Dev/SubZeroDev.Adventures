import { useAccount } from "../app/providers/AccountProvider";
/** The player's record; chrome, theme and identity belong to AppShell. */
import { useEffect, useState } from "react";
import type { BrowserCampaign } from "../play/composition";
import { useBadges, useProfileSettings, useProgress } from "../play/identity";
import { PlayerHome } from "../play/PlayerHome";

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
  const {
    identity,
    loading: identityLoading,
    refreshToken: identityRefreshToken,
  } = useAccount();
  const progress = useProgress(apiUrl, identity.playerId);
  const { badges, records } = useBadges(apiUrl, identity.playerId);
  const { settings, setPublic } = useProfileSettings(
    apiUrl,
    identity.playerId,
    identityRefreshToken,
  );
  const catalog = useCatalog(apiUrl);

  const ready =
    Boolean(apiUrl) && !identityLoading && identity.kind !== "anonymous";

  return (
    <>
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
    </>
  );
}
