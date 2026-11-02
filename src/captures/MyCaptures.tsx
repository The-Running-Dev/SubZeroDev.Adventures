import { useTranslation } from "react-i18next";
import { ResourceState } from "../components/ResourceState";
import { useLocale } from "../app/locale/useLocale";
import { CaptureError } from "./CaptureError";
import { useCaptureConsent, useMyCaptures } from "./useCaptures";

/**
 * `/captures`: the player's own problem reports and the fault-capture consent setting
 * (`docs/session-capture.md`). Both are account-scoped, so neither exists without an API
 * and a principal.
 */
export function MyCaptures({ apiUrl }: { apiUrl?: string }) {
  const { t } = useTranslation("captures");
  const model = useMyCaptures(apiUrl);
  const { identity, identityLoading, ready, online, query } = model;
  return (
    <section
      className="feature-page archive admin"
      aria-labelledby="captures-title"
    >
      <div className="archive-heading">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1 id="captures-title">{t("title")}</h1>
        <p className="admin-note">{t("intro")}</p>

        {!apiUrl && <p className="profile-unavailable">{t("unavailable")}</p>}
        {apiUrl && identityLoading && (
          <p className="profile-unavailable" role="status">
            {t("loading")}
          </p>
        )}
        {apiUrl && !identityLoading && identity.kind === "anonymous" && (
          <p className="profile-unavailable">{t("anonymous")}</p>
        )}
      </div>

      {ready && (
        <>
          <FaultConsent apiUrl={apiUrl} online={online} />
          {!online && <ResourceState state="offline" />}
          {query.isPending && <ResourceState state="loading" />}
          {query.isError && (
            <ResourceState
              state="error"
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          )}
          {!query.isPending && !query.isError && <CaptureList {...model} />}
        </>
      )}
    </section>
  );
}

function FaultConsent({
  apiUrl,
  online,
}: {
  apiUrl?: string;
  online: boolean;
}) {
  const { t } = useTranslation("captures");
  const { date } = useLocale();
  const { query, saving, saveError, setFaultCapture } =
    useCaptureConsent(apiUrl);
  return (
    <section className="admin-block" aria-labelledby="fault-consent-title">
      <h2 className="admin-heading" id="fault-consent-title">
        {t("fault.title")}
      </h2>
      <p className="admin-note">{t("fault.body")}</p>
      {query.isPending && <ResourceState state="loading" />}
      {query.isError && (
        <ResourceState
          state="error"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && (
        <>
          <label className="report-problem-consent">
            <input
              type="checkbox"
              checked={query.data.faultCapture}
              disabled={!online || saving}
              onChange={(event) => void setFaultCapture(event.target.checked)}
            />
            <span>{t("fault.label")}</span>
          </label>
          <p className="admin-note" role="status">
            {saving
              ? t("fault.saving")
              : query.data.faultCapture && query.data.consentedAt
                ? t("fault.consentedAt", {
                    date: date(query.data.consentedAt),
                  })
                : t("fault.off")}
          </p>
        </>
      )}
      {saveError !== undefined && (
        <ResourceState state="error" error={saveError} />
      )}
    </section>
  );
}

function CaptureList({
  online,
  captures,
  busyId,
  rowError,
  handleDownload,
  handleDelete,
  deletingAll,
  deleteAllError,
  handleDeleteAll,
}: ReturnType<typeof useMyCaptures>) {
  const { t } = useTranslation("captures");
  const { date } = useLocale();
  return (
    <section className="admin-block" aria-labelledby="capture-list-title">
      <h2 className="admin-heading" id="capture-list-title">
        {t("list.title")}
      </h2>
      <div className="admin-table-scroll" tabIndex={0}>
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">{t("list.created")}</th>
              <th scope="col">{t("list.campaign")}</th>
              <th scope="col">{t("list.trigger")}</th>
              <th scope="col">{t("list.expires")}</th>
              <th scope="col">{t("list.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {captures.map((capture) => (
              <tr key={capture.captureId}>
                <td>{date(capture.createdAt)}</td>
                <td>{capture.campaignId}</td>
                <td>{t(`triggers.${capture.trigger}`)}</td>
                <td>{date(capture.expiresAt)}</td>
                <td>
                  <RowActions
                    id={capture.captureId}
                    online={online}
                    busyId={busyId}
                    onDownload={handleDownload}
                    onDelete={handleDelete}
                  />
                  {rowError?.id === capture.captureId && (
                    <CaptureError error={rowError.error} />
                  )}
                </td>
              </tr>
            ))}
            {captures.length === 0 && (
              <tr>
                <td colSpan={5}>{t("list.empty")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {captures.length > 0 && (
        <button
          type="button"
          className="admin-remove"
          disabled={!online || deletingAll}
          onClick={() => void handleDeleteAll()}
        >
          {t(deletingAll ? "list.deletingAll" : "list.deleteAll")}
        </button>
      )}
      {deleteAllError !== undefined && <CaptureError error={deleteAllError} />}
    </section>
  );
}

/** Download and delete, the same pair on the player's list and the admin's. */
export function RowActions({
  id,
  online,
  busyId,
  onDownload,
  onDelete,
}: {
  id: string;
  online: boolean;
  busyId?: string;
  onDownload: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation("captures");
  const busy = busyId === id;
  return (
    <>
      <button
        type="button"
        className="admin-sync admin-row-action"
        disabled={!online || busy}
        onClick={() => void onDownload(id)}
      >
        {t("list.download")}
      </button>
      <button
        type="button"
        className="admin-remove admin-row-action"
        disabled={!online || busy}
        onClick={() => void onDelete(id)}
      >
        {t("list.delete")}
      </button>
    </>
  );
}
