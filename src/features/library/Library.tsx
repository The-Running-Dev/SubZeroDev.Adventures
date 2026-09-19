import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useLibrary } from "./useLibrary";
import { useOnline } from "../../pwa/usePwa";
import { Panel } from "../../components/Panel";
import { Stat } from "../../components/Stat";
import { CampaignCard } from "../../components/CampaignCard";
import { ResourceState } from "../../components/ResourceState";
import { BadgeGrid } from "../../play/BadgeGrid";
import "./library.css";

export default function Library() {
  const { t } = useTranslation("library");
  const online = useOnline();
  const { account, catalog, progress, saves, badges, stats } = useLibrary();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const campaigns = useMemo(
    () => (catalog.data?.campaigns ?? []).filter((c) => !c.hidden),
    [catalog.data],
  );
  const progressById = new Map(
    progress.data?.progress.map((p) => [p.campaignId, p]),
  );
  const resumable = new Set(saves.data?.saves.map((s) => s.campaignId));
  const latest = [...(saves.data?.saves ?? [])]
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    .find((save) => campaigns.some((c) => c.campaignId === save.campaignId));
  const continuing = campaigns.find((c) => c.campaignId === latest?.campaignId);
  const visible = campaigns.filter(
    (c) =>
      (!search ||
        `${c.title} ${c.description}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())) &&
      (filter === "all" ||
        (filter === "featured" && c.featured) ||
        (filter === "started" && progressById.has(c.campaignId))),
  );
  const entries = progress.data?.progress ?? [];
  const owned = Boolean(account.identity.playerId && account.apiUrl);
  const state = (query: {
    isPending: boolean;
    error: unknown;
    refetch: () => unknown;
  }) => (
    <ResourceState
      state={!online ? "offline" : query.isPending ? "loading" : "error"}
      error={query.error}
      onRetry={
        online
          ? () => {
              void query.refetch();
            }
          : undefined
      }
    />
  );
  return (
    <div className="library-page">
      <section className="library-hero" aria-labelledby="library-title">
        <p className="eyebrow">SUBZERO / ADVENTURES</p>
        <h1 id="library-title">{t("title")}</h1>
        <p>{t("intro")}</p>
        {!owned && !account.loading && (
          <p className="library-welcome">{t("welcomeBody")}</p>
        )}
        <Link className="app-button" to="/start">
          {t("gettingStarted")}
        </Link>
      </section>
      {owned && (
        <section aria-labelledby="continue-title">
          <h2 id="continue-title">{t("continueTitle")}</h2>
          {saves.isPending || saves.error ? (
            state(saves)
          ) : continuing ? (
            <CampaignCard
              campaign={continuing}
              progress={progressById.get(continuing.campaignId)}
              resumable
              disabled={!online}
            />
          ) : (
            <p>{t("noSave")}</p>
          )}
        </section>
      )}
      <section aria-labelledby="campaigns-title">
        <div className="library-heading">
          <h2 id="campaigns-title">{t("campaigns")}</h2>
          <div className="library-filters">
            <label>
              {t("search")}
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              {t("filter")}
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">{t("all")}</option>
                <option value="featured">{t("featured")}</option>
                {owned && <option value="started">{t("started")}</option>}
              </select>
            </label>
          </div>
        </div>
        {catalog.isPending || catalog.error ? (
          state(catalog)
        ) : visible.length ? (
          <div className="campaign-grid">
            {visible.map((campaign) => (
              <CampaignCard
                key={campaign.campaignId}
                campaign={campaign}
                progress={progressById.get(campaign.campaignId)}
                resumable={resumable.has(campaign.campaignId)}
                disabled={!online}
              />
            ))}
          </div>
        ) : (
          <ResourceState state="empty" />
        )}
      </section>
      {owned && (
        <Panel aria-labelledby="your-record-title">
          <h2 id="your-record-title">
            {t("yourRecord", {
              name: account.identity.displayName ?? t("guest"),
            })}
          </h2>
          {progress.isPending || progress.error ? (
            state(progress)
          ) : (
            <dl className="stat-grid">
              <Stat label={t("storiesStarted")} value={entries.length} />
              <Stat
                label={t("storiesFinished")}
                value={entries.filter((p) => p.status === "ended").length}
              />
              <Stat
                label={t("steps")}
                value={entries.reduce((n, p) => n + p.stepCount, 0)}
              />
              <Stat
                label={t("achievements")}
                value={entries.reduce((n, p) => n + p.achievements.length, 0)}
              />
            </dl>
          )}
          {badges.isPending || badges.error ? (
            state(badges)
          ) : (
            <details className="library-badges">
              <summary>
                {t("badges", { count: badges.data?.badges.length ?? 0 })}
              </summary>
              <BadgeGrid badges={badges.data?.badges ?? []} />
            </details>
          )}
          <Link to="/profile">{t("viewProfile")}</Link>
        </Panel>
      )}
      {account.apiUrl && (
        <Panel aria-labelledby="network-title">
          <h2 id="network-title">{t("network")}</h2>
          <p>{t("networkBody")}</p>
          {stats.isPending || stats.error
            ? state(stats)
            : stats.data && (
                <dl className="stat-grid">
                  <Stat label={t("players")} value={stats.data.players} />
                  <Stat label={t("runs")} value={stats.data.sessions} />
                  <Stat
                    label={t("completedRuns")}
                    value={stats.data.sessionsFinished}
                  />
                  <Stat label={t("steps")} value={stats.data.stepsTaken} />
                  <Stat
                    label={t("achievements")}
                    value={stats.data.achievementsUnlocked}
                  />
                  <Stat
                    label={t("badgesLabel")}
                    value={stats.data.badgesUnlocked}
                  />
                </dl>
              )}
        </Panel>
      )}
    </div>
  );
}
