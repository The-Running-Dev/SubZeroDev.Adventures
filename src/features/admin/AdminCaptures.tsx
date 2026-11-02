import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ResourceState } from "../../components/ResourceState";
import { useLocale } from "../../app/locale/useLocale";
import { useAccount } from "../../app/providers/AccountProvider";
import { useOnline } from "../../pwa/usePwa";
import { CaptureError } from "../../captures/CaptureError";
import { RowActions } from "../../captures/MyCaptures";
import { useAdminCaptures } from "../../captures/useCaptures";
import type { AdminPanelProps } from "./types";
import { shortPreview } from "./presentation";

/**
 * Every live capture (`GET /api/admin/captures`), with download and delete, plus capturing a
 * session on a player's behalf (`POST /api/admin/captures`) when acting on a report that
 * arrived some other way. Rendered only for an admin, so the list request is never a 403.
 */
export function AdminCaptures({ demo }: Pick<AdminPanelProps, "demo">) {
  const { isAdmin } = useAccount();
  return demo.apiUrl && isAdmin ? (
    <AdminCaptureList apiUrl={demo.apiUrl} />
  ) : null;
}

function AdminCaptureList({ apiUrl }: { apiUrl: string }) {
  const { t } = useTranslation("captures");
  const { date } = useLocale();
  const online = useOnline();
  const {
    query,
    captures,
    busyId,
    rowError,
    handleDownload,
    handleDelete,
    capturing,
    captureOutcome,
    handleCapture,
  } = useAdminCaptures(apiUrl);
  const [sessionId, setSessionId] = useState("");
  const [consent, setConsent] = useState(false);

  return (
    <section className="admin-block" aria-labelledby="admin-captures-title">
      <h2 className="admin-heading" id="admin-captures-title">
        {t("admin.title")}
      </h2>
      <p className="admin-note">{t("admin.note")}</p>
      {query.isPending && <ResourceState state="loading" />}
      {query.isError && (
        <ResourceState
          state="error"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      <div className="admin-table-scroll" tabIndex={0}>
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">{t("admin.capture")}</th>
              <th scope="col">{t("admin.player")}</th>
              <th scope="col">{t("list.campaign")}</th>
              <th scope="col">{t("list.trigger")}</th>
              <th scope="col">{t("list.created")}</th>
              <th scope="col">{t("list.expires")}</th>
              <th scope="col">{t("list.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {captures.map((capture) => (
              <tr key={capture.captureId}>
                <td>
                  <code title={capture.captureId}>
                    {shortPreview(capture.captureId, 12)}
                  </code>
                </td>
                <td>
                  <code title={capture.playerId}>
                    {shortPreview(capture.playerId, 12)}
                  </code>
                </td>
                <td>{capture.campaignId}</td>
                <td>{t(`triggers.${capture.trigger}`)}</td>
                <td>{date(capture.createdAt)}</td>
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
            {query.isSuccess && captures.length === 0 && (
              <tr>
                <td colSpan={7}>{t("list.empty")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCapture(sessionId.trim()).then((ok) => {
            if (ok) {
              setSessionId("");
              setConsent(false);
            }
          });
        }}
      >
        <div className="admin-form-row">
          <input
            type="text"
            aria-label={t("admin.sessionId")}
            placeholder={t("admin.sessionId")}
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
          />
          <button
            type="submit"
            className="admin-sync"
            disabled={!online || capturing || !consent || !sessionId.trim()}
          >
            {t(capturing ? "admin.capturing" : "admin.submit")}
          </button>
        </div>
        <label className="report-problem-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>{t("admin.consent")}</span>
        </label>
      </form>
      {captureOutcome?.ok === true && (
        <p className="admin-notice" role="status">
          {t("admin.captured", { id: captureOutcome.captureId })}
        </p>
      )}
      {captureOutcome?.ok === false && (
        <CaptureError error={captureOutcome.error} />
      )}
    </section>
  );
}
