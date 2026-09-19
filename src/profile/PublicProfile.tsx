import { ApiError } from "../api/client";
import { ResourceState } from "../components/ResourceState";
import { useTranslation } from "react-i18next";
import { useLocale } from "../app/locale/useLocale";
/**
 * A player's public profile, reached via `/u/<slug>` (main.tsx's routing) -- a standalone
 * top-level view, not nested under `PlayApp`/`BrowserDemo`, mirroring `src/oauth/`'s shape
 * for the same reason: this page exists outside the game-loading flow entirely.
 *
 * `apiUrl` is read once by `main.tsx` and passed down as a prop rather than read here via
 * `import.meta.env.VITE_API_URL` directly -- the latter would make this component only
 * ever exercise its local-mode branch under this repo's test suite, which pins
 * `VITE_API_URL: ""` for the whole run (vite.config.ts, issue #18).
 */
import type { CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { getProfile } from "../api/profile";
import { usePublicCampaigns } from "../api/queries";
import type { PublicProfileData } from "../play/identity";
import { playEarnedBadgeCount } from "../play/badges";
import { ProfileRankBadge } from "../play/ProfileRankBadge";
import { BadgeGrid } from "../play/BadgeGrid";
import { PersonnelFile } from "../play/PersonnelFile";

function fill(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

type Stage =
  | { readonly kind: "unavailable" }
  | { readonly kind: "loading" }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly data: PublicProfileData };

export function PublicProfile({
  apiUrl,
  slug,
}: {
  apiUrl?: string;
  slug: string;
}) {
  const { t } = useTranslation("community");
  const { number, date } = useLocale();
  const query = useQuery({
    queryKey: ["public", apiUrl, "profile", slug],
    queryFn: ({ signal }) => getProfile(apiUrl, slug, signal),
    enabled: Boolean(apiUrl),
  });
  // Anonymous, not the viewer's own catalog: this page is rendered for strangers, so the
  // titles on it must not vary by who is looking (and must not wait on `/api/me`).
  const campaigns = usePublicCampaigns(apiUrl);
  const stage: Stage = !apiUrl
    ? { kind: "unavailable" }
    : query.isPending
      ? { kind: "loading" }
      : query.isError
        ? {
            kind:
              query.error instanceof ApiError && query.error.status === 404
                ? "not-found"
                : "failed",
          }
        : { kind: "loaded", data: query.data };

  function findCampaignTitle(campaignId: string): string {
    return (
      campaigns.data?.campaigns.find((c) => c.campaignId === campaignId)
        ?.title ?? campaignId
    );
  }

  return (
    <>
      <section className="feature-page archive" aria-labelledby="profile-title">
        <div className="archive-heading">
          <p className="eyebrow">{t("profileEyebrow")}</p>
          <h1 id="profile-title">{t("publicProfile")}</h1>

          {stage.kind === "unavailable" && (
            <p className="profile-unavailable">{t("profileUnavailable")}</p>
          )}
          {stage.kind === "loading" && (
            <p className="profile-unavailable" role="status">
              {t("publicLoading")}
            </p>
          )}
          {stage.kind === "failed" && (
            <ResourceState
              state="error"
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          )}
          {stage.kind === "not-found" && (
            <p className="profile-unavailable">{t("profileMissing")}</p>
          )}
        </div>

        {stage.kind === "loaded" && (
          <>
            <h2>{stage.data.displayName}</h2>
            <ProfileRankBadge
              badgeCount={playEarnedBadgeCount(stage.data.badges)}
            />
            <dl className="home-summary">
              <div>
                <dt>{t("started")}</dt>
                <dd>{number(stage.data.sessionsStarted)}</dd>
              </div>
              <div
                className="stat-metered"
                style={
                  {
                    "--stat-fill": `${fill(stage.data.sessionsFinished, stage.data.sessionsStarted)}%`,
                  } as CSSProperties
                }
              >
                <dt>{t("finished")}</dt>
                <dd>{number(stage.data.sessionsFinished)}</dd>
              </div>
              <div
                className="stat-metered"
                style={
                  {
                    "--stat-fill": `${fill(stage.data.campaignsPlayed, stage.data.campaignsTotal)}%`,
                  } as CSSProperties
                }
              >
                <dt>{t("touched")}</dt>
                <dd>
                  {number(stage.data.campaignsPlayed)}
                  <span className="stat-ceiling">
                    {" "}
                    / {stage.data.campaignsTotal}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("logged")}</dt>
                <dd>{number(stage.data.stepsTaken)}</dd>
              </div>
              <div>
                <dt>{t("found")}</dt>
                <dd>{number(stage.data.endingsFound)}</dd>
              </div>
              <div>
                <dt>{t("achievements")}</dt>
                <dd>{number(stage.data.achievementsUnlocked)}</dd>
              </div>
              <div>
                <dt>{t("joined")}</dt>
                <dd>{date(stage.data.joinedAt)}</dd>
              </div>
            </dl>
            <BadgeGrid badges={stage.data.badges} />
            <PersonnelFile
              records={stage.data.records}
              findCampaignTitle={findCampaignTitle}
            />
          </>
        )}
      </section>
    </>
  );
}
