import { useTranslation } from "react-i18next";
import { ResourceState } from "../../components/ResourceState";
import type { AdminPanelProps } from "./types";
import type { useAdminController } from "./useAdminController";
import { Link } from "react-router";
import { useLocale } from "../../app/locale/useLocale";
export function AdminOverview({
  demo,
  syncing,
  syncError,
  lastSyncedAt,
  onSync,
  adminStatus,
  statusError,
  refetchStatus,
  statusLoading,
  listed,
  online,
}: AdminPanelProps & ReturnType<typeof useAdminController>) {
  const { t } = useTranslation("admin");
  const { date } = useLocale();
  const formatTimestamp = (value?: string) =>
    value ? date(value, { dateStyle: "short", timeStyle: "short" }) : "—";
  return (
    <>
      {!online && <ResourceState state="offline" />}
      <div className="archive-heading">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1 id="admin-title" className="admin-title">
          {t("title")}
        </h1>
        <p className="admin-note">{t("intro")}</p>
      </div>
      <section className="admin-block">
        <h2 className="admin-heading">{t("source")}</h2>
        <dl className="admin-facts">
          <dt>{t("mode")}</dt>
          <dd>{demo.apiUrl ? t("remote") : t("local")}</dd>
          <dt>{t("origin")}</dt>
          <dd>
            <code>{demo.apiUrl ?? t("noBackend")}</code>
          </dd>
          <dt>{t("listed")}</dt>
          <dd>{listed}</dd>
          <dt>{t("lastSynced")}</dt>
          <dd>{lastSyncedAt}</dd>
        </dl>

        <button
          type="button"
          className="admin-sync"
          onClick={onSync}
          disabled={syncing || !online}
        >
          {syncing ? t("syncing") : t("syncCatalog")}
        </button>

        {syncError !== undefined && (
          <div className="admin-error" role="alert">
            {t("syncFailed")}
            <details>
              <summary>{t("diagnostics")}</summary>
              <pre>{syncError}</pre>
            </details>
          </div>
        )}
      </section>
      {demo.apiUrl && (
        <section className="admin-block">
          <h2 className="admin-heading">{t("serverContent")}</h2>
          {statusLoading && <ResourceState state="loading" />}
          <dl className="admin-facts">
            <dt>{t("access")}</dt>
            <dd>
              {adminStatus
                ? adminStatus.isAdmin
                  ? t("allowed")
                  : t("notAllowed")
                : "—"}
            </dd>
            <dt>{t("digest")}</dt>
            <dd>
              <code>{adminStatus?.status.contentDigest ?? "—"}</code>
            </dd>
            <dt>{t("serverCampaigns")}</dt>
            <dd>{adminStatus?.status.campaignCount ?? "—"}</dd>
            <dt>{t("successAt")}</dt>
            <dd>{formatTimestamp(adminStatus?.status.lastSuccessAt)}</dd>
            <dt>{t("failureAt")}</dt>
            <dd>{formatTimestamp(adminStatus?.status.lastFailureAt)}</dd>
            {adminStatus?.status.lastError && (
              <>
                <dt>{t("failure")}</dt>
                <dd>
                  <details>
                    <summary>{t("diagnostics")}</summary>
                    <pre>{adminStatus.status.lastError}</pre>
                  </details>
                </dd>
              </>
            )}
          </dl>

          {adminStatus?.status.bootstrapFallback && (
            // The server started, but not from its own sources -- without saying so, the
            // catalog above looks like a normal one and the failure above looks historical.
            <p className="admin-notice admin-notice-warn" role="status">
              {t("fallback")}
            </p>
          )}

          {statusError !== undefined && (
            <ResourceState
              state="error"
              error={statusError}
              onRetry={refetchStatus}
            />
          )}
          {adminStatus && !adminStatus.isAdmin && (
            <p className="admin-notice admin-notice-warn" role="status">
              {t("authorized")} <Link to="/">{t("signIn")}</Link>, {t("reload")}
            </p>
          )}
        </section>
      )}
    </>
  );
}
