import { useTranslation } from "react-i18next";
import { ResourceState } from "../../components/ResourceState";
import type { AdminPanelProps } from "./types";
import type { useAdminController } from "./useAdminController";
import { shortPreview } from "./presentation";
export function AdminQueue({
  demo,
  canManageSources,
  pendingSubmissions,
  queueError,
  refetchQueue,
  queueLoading,
  reviewBusyId,
  reviewError,
  review,
}: AdminPanelProps & ReturnType<typeof useAdminController>) {
  const { t } = useTranslation("admin");
  return (
    <>
      {demo.apiUrl && (
        <section className="admin-block">
          <h2 className="admin-heading">{t("queue")}</h2>
          <p className="admin-note">{t("queueIntro")}</p>
          {queueLoading && <ResourceState state="loading" />}
          {queueError !== undefined && (
            <ResourceState
              state="error"
              error={queueError}
              onRetry={refetchQueue}
            />
          )}
          <div className="admin-table-scroll" tabIndex={0}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t("label")}</th>
                  <th scope="col">{t("kind")}</th>
                  <th scope="col">{t("author")}</th>
                  <th scope="col">{t("campaigns")}</th>
                  <th scope="col">{t("issue")}</th>
                  <th scope="col">{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {pendingSubmissions.map((submission) => (
                  <tr key={submission.id}>
                    <td>{submission.label}</td>
                    <td>{t(`content:${submission.kind}`)}</td>
                    <td>
                      <code>
                        {submission.ownerPlayerId
                          ? shortPreview(submission.ownerPlayerId, 12)
                          : "—"}
                      </code>
                    </td>
                    <td>{submission.campaignCount ?? "—"}</td>
                    <td>
                      {submission.lastError || submission.quarantineReason ? (
                        <details>
                          <summary>{t("issue")}</summary>
                          <pre className="content-diagnostic">
                            {submission.lastError ??
                              submission.quarantineReason}
                          </pre>
                        </details>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="admin-sync admin-row-action"
                        onClick={() => void review(submission.id, "approve")}
                        disabled={
                          reviewBusyId === submission.id || !canManageSources
                        }
                      >
                        {t("approve")}
                      </button>
                      <button
                        type="button"
                        className="admin-remove admin-row-action"
                        onClick={() => void review(submission.id, "reject")}
                        disabled={
                          reviewBusyId === submission.id || !canManageSources
                        }
                      >
                        {t("reject")}
                      </button>
                      {reviewError?.id === submission.id && (
                        <ResourceState
                          state="error"
                          error={reviewError.error}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {!queueError &&
                  !queueLoading &&
                  pendingSubmissions.length === 0 && (
                    <tr>
                      <td colSpan={6}>{t("emptyQueue")}</td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
