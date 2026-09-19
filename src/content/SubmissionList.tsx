import { useTranslation } from "react-i18next";
import type { useMyContent } from "./useMyContent";
import { ResourceState } from "../components/ResourceState";
import { statusLabel } from "./statusLabel";
export function SubmissionList({
  online,
  submissions,
  busyId,
  rowError,
  handleDelete,
  handleRequestPublish,
}: ReturnType<typeof useMyContent>) {
  const { t } = useTranslation("content");
  return (
    <section className="admin-block">
      <h2 className="admin-heading">{t("submissions")}</h2>
      <div className="admin-table-scroll" tabIndex={0}>
        <table className="admin-table">
          <thead>
            <tr>
              <th scope="col">{t("label")}</th>
              <th scope="col">{t("kind")}</th>
              <th scope="col">{t("status")}</th>
              <th scope="col">{t("campaigns")}</th>
              <th scope="col">{t("issue")}</th>
              <th scope="col">{t("admin:actions")}</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((submission) => (
              <tr key={submission.id}>
                <td>{submission.label}</td>
                <td>{t(submission.kind)}</td>
                <td>{t(statusLabel(submission))}</td>
                <td>{submission.campaignCount ?? "—"}</td>
                <td>
                  {submission.lastError || submission.quarantineReason ? (
                    <details>
                      <summary>
                        {t(submission.lastError ? "loadIssue" : "quarantined")}
                      </summary>
                      <pre className="content-diagnostic">
                        {submission.lastError ?? submission.quarantineReason}
                      </pre>
                    </details>
                  ) : (
                    (submission.reviewNote ?? "—")
                  )}
                </td>
                <td>
                  {submission.visibility === "private" &&
                    submission.status !== "pending" && (
                      <button
                        type="button"
                        className="admin-sync admin-row-action"
                        onClick={() => void handleRequestPublish(submission.id)}
                        disabled={!online || busyId === submission.id}
                      >
                        {t("review")}
                      </button>
                    )}
                  <button
                    type="button"
                    className="admin-remove admin-row-action"
                    onClick={() => void handleDelete(submission.id)}
                    disabled={!online || busyId === submission.id}
                  >
                    {busyId === submission.id ? t("removing") : t("delete")}
                  </button>
                  {rowError?.id === submission.id && (
                    <ResourceState state="error" error={rowError.error} />
                  )}
                </td>
              </tr>
            ))}
            {submissions.length === 0 && (
              <tr>
                <td colSpan={6}>{t("empty")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
