import { useTranslation } from "react-i18next";
import { useProfileData } from "./useProfileData";
import { ResourceState } from "../components/ResourceState";
import { PlayerHome } from "../play/PlayerHome";

export function OwnProfile({ apiUrl }: { apiUrl?: string }) {
  const { t } = useTranslation("community");

  const { account, progress, badges, catalog, profile } =
    useProfileData(apiUrl);
  const { identity, loading: identityLoading } = account;
  const queries = [progress, badges, catalog];
  const failed = queries.find((q) => q.isError);
  const ready =
    Boolean(apiUrl) && !identityLoading && identity.kind !== "anonymous";
  const loading = queries.some((q) => q.isPending) || profile.loading;

  return (
    <>
      <section className="feature-page archive" aria-labelledby="profile-title">
        <div className="archive-heading">
          <p className="eyebrow">{t("profileEyebrow")}</p>
          <h1 id="profile-title">{t("profile")}</h1>

          {!apiUrl && (
            <p className="profile-unavailable">{t("profileUnavailable")}</p>
          )}
          {apiUrl && identityLoading && (
            <p className="profile-unavailable" role="status">
              {t("profileLoading")}
            </p>
          )}
          {apiUrl && !identityLoading && identity.kind === "anonymous" && (
            <p className="profile-unavailable">{t("profileAnonymous")}</p>
          )}
        </div>

        {ready && failed && (
          <ResourceState
            state="error"
            error={failed.error}
            onRetry={() => void failed.refetch()}
          />
        )}
        {ready && !failed && profile.error && (
          <ResourceState
            state="error"
            error={profile.error}
            onRetry={profile.retry}
          />
        )}
        {ready && !failed && !profile.error && loading && (
          <ResourceState state="loading" />
        )}
        {ready && !failed && !profile.error && !loading && (
          <PlayerHome
            identity={identity}
            progress={
              new Map(progress.data?.progress.map((p) => [p.campaignId, p]))
            }
            badges={badges.data?.badges ?? []}
            records={badges.data?.records ?? null}
            catalog={catalog.data?.campaigns.filter((c) => !c.hidden) ?? []}
            settings={profile.settings}
            setPublic={profile.setPublic}
          />
        )}
      </section>
    </>
  );
}
