import { useAccount } from "../app/providers/AccountProvider";
/** The player's record; chrome, theme and identity belong to AppShell. */
import { useCampaigns } from "../api/queries";
import { useBadges, useProfileSettings, useProgress } from "../play/identity";
import { PlayerHome } from "../play/PlayerHome";

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
  const campaigns = useCampaigns(apiUrl);
  const catalog =
    campaigns.data?.campaigns.filter((campaign) => !campaign.hidden) ?? [];

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
