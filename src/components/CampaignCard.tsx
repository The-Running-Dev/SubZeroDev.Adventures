import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { BrowserCampaign } from "../play/composition";
import type { CampaignProgress } from "../play/identity";
import { useLocale } from "../app/locale/useLocale";

export function CampaignCard({
  campaign,
  progress,
  resumable = false,
  disabled = false,
}: {
  campaign: BrowserCampaign;
  progress?: CampaignProgress;
  resumable?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("library");
  const { number } = useLocale();
  return (
    <article
      className={`campaign-card${campaign.featured ? " campaign-card--featured" : ""}`}
    >
      <div className="campaign-card-meta">
        <span>
          {t(`kinds.${campaign.kindId}`, { defaultValue: campaign.kindId })}
        </span>
        {campaign.featured && <span>{t("featured")}</span>}
        {campaign.mine && (
          <span>
            {t(campaign.visibility === "public" ? "yourPublic" : "yourPrivate")}
          </span>
        )}
      </div>
      <h3>{campaign.title}</h3>
      <p>{campaign.description}</p>
      {campaign.duration && (
        <p className="campaign-duration">{campaign.duration}</p>
      )}
      {campaign.contentNotice && (
        <details>
          <summary>{t("contentNotice")}</summary>
          <p>{campaign.contentNotice}</p>
        </details>
      )}
      {progress && (
        <p className="campaign-progress">
          {t(progress.status === "ended" ? "finished" : "inProgress", {
            count: progress.stepCount,
          })}
          {progress.endings.total > 0 && (
            <>
              {" "}
              ·{" "}
              {t("endings", {
                found: number(progress.endings.discovered.length),
                total: number(progress.endings.total),
              })}
            </>
          )}
        </p>
      )}
      <div className="campaign-card-actions">
        {disabled ? (
          <span className="app-button" aria-disabled="true">
            {t("reconnect")}
          </span>
        ) : (
          <Link
            className="app-button app-button--primary"
            to={`/?campaign=${encodeURIComponent(campaign.campaignId)}`}
          >
            {t(resumable ? "continue" : "play")}
            <span className="visually-hidden">: {campaign.title}</span>
          </Link>
        )}
      </div>
    </article>
  );
}
