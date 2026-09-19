import { useTranslation } from "react-i18next";
import { ResourceState } from "../../components/ResourceState";
import type { AdminPanelProps } from "./types";
import type { useAdminController } from "./useAdminController";
import { useLocale } from "../../app/locale/useLocale";
import { shortPreview, AddOutcomeNote } from "./presentation";
export function AdminSources({
  demo,
  syncing,
  onSync,
  online,
  adminStatus,
  canManageSources,
  urlLabel,
  setUrlLabel,
  urlValue,
  setUrlValue,
  addingUrl,
  urlOutcome,
  pasteText,
  setPasteText,
  addingPaste,
  pasteOutcome,
  fileInput,
  selectedFile,
  setSelectedFile,
  addingFile,
  fileOutcome,
  setFileOutcome,
  removingId,
  removeError,
  handleAddUrl,
  handleAddPaste,
  handleAddFile,
  handleRemove,
}: AdminPanelProps & ReturnType<typeof useAdminController>) {
  const { t } = useTranslation("admin");
  const { date } = useLocale();
  const formatTimestamp = (value?: string) =>
    value ? date(value, { dateStyle: "short", timeStyle: "short" }) : "—";
  return (
    <>
      {demo.apiUrl && (
        <section className="admin-block">
          <h2 className="admin-heading">{t("sources")}</h2>
          <p className="admin-note">{t("sourcesIntro")}</p>
          <div className="admin-table-scroll" tabIndex={0}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t("label")}</th>
                  <th scope="col">{t("kind")}</th>
                  <th scope="col">{t("origin")}</th>
                  <th scope="col">{t("lastSynced")}</th>
                  <th scope="col">{t("lastError")}</th>
                  <th scope="col">{t("campaigns")}</th>
                  <th scope="col">{t("extensions")}</th>
                  <th scope="col">{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {(adminStatus?.sources ?? []).map((source) => (
                  <tr key={source.id}>
                    <td>
                      {source.label}
                      {source.builtin ? t("default") : ""}
                    </td>
                    <td>{t(`content:${source.kind}`)}</td>
                    <td>
                      <code>
                        {source.url
                          ? shortPreview(source.url)
                          : t("pastedJson")}
                      </code>
                    </td>
                    <td>{formatTimestamp(source.lastSyncedAt)}</td>
                    <td>
                      {source.lastError ? (
                        <details>
                          <summary>{t("lastError")}</summary>
                          <pre className="content-diagnostic">
                            {source.lastError}
                          </pre>
                        </details>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{source.campaignCount ?? "—"}</td>
                    <td>{source.extensionCount ?? "—"}</td>
                    <td>
                      {!source.lastError && (
                        <button
                          type="button"
                          className="admin-sync admin-row-action"
                          onClick={onSync}
                          disabled={syncing || !online}
                        >
                          {t("sync")}
                        </button>
                      )}
                      {source.removable && (
                        <button
                          type="button"
                          className="admin-remove admin-row-action"
                          onClick={() => void handleRemove(source.id)}
                          disabled={
                            removingId === source.id || !canManageSources
                          }
                        >
                          {removingId === source.id
                            ? t("removing")
                            : t("remove")}
                        </button>
                      )}
                      {removeError?.id === source.id && (
                        <ResourceState
                          state="error"
                          error={removeError.error}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {(adminStatus?.sources ?? []).length === 0 && (
                  <tr>
                    <td colSpan={8}>{t("noSources")}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="admin-form">
            <h3 className="admin-subheading">{t("urlSource")}</h3>
            <div className="admin-form-row">
              <input
                type="text"
                aria-label={t("label")}
                placeholder={t("label")}
                value={urlLabel}
                onChange={(event) => setUrlLabel(event.target.value)}
                disabled={!canManageSources}
              />
              <input
                type="text"
                aria-label={t("content:sourceUrl")}
                placeholder="https://…/campaigns/"
                value={urlValue}
                onChange={(event) => setUrlValue(event.target.value)}
                disabled={!canManageSources}
              />
              <button
                type="button"
                className="admin-sync"
                onClick={() => void handleAddUrl()}
                disabled={
                  addingUrl || !urlLabel || !urlValue || !canManageSources
                }
              >
                {addingUrl ? t("adding") : t("add")}
              </button>
            </div>
            {urlOutcome && <AddOutcomeNote outcome={urlOutcome} />}
          </div>

          <div className="admin-form">
            <h3 className="admin-subheading">{t("paste")}</h3>
            <textarea
              className="admin-paste"
              aria-label={t("paste")}
              placeholder={t("pasteHint")}
              value={pasteText}
              onChange={(event) => setPasteText(event.target.value)}
              rows={6}
              disabled={!canManageSources}
            />
            <div className="admin-form-row">
              <button
                type="button"
                className="admin-sync"
                onClick={() => void handleAddPaste()}
                disabled={addingPaste || !pasteText.trim() || !canManageSources}
              >
                {addingPaste ? t("adding") : t("add")}
              </button>
            </div>
            {pasteOutcome && <AddOutcomeNote outcome={pasteOutcome} />}
          </div>

          <div className="admin-form">
            <h3 className="admin-subheading">{t("uploadTitle")}</h3>
            <div className="admin-form-row">
              <label className="admin-file-label" htmlFor="admin-json-file">
                {t("file")}
              </label>
              <input
                ref={fileInput}
                id="admin-json-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  setSelectedFile(event.target.files?.[0]);
                  setFileOutcome(undefined);
                }}
                disabled={!canManageSources || addingFile}
              />
              <button
                type="button"
                className="admin-sync"
                onClick={() => void handleAddFile()}
                disabled={!selectedFile || !canManageSources || addingFile}
              >
                {addingFile ? t("uploading") : t("upload")}
              </button>
            </div>
            {selectedFile && (
              <p className="admin-file-name" role="status">
                {t("selected", { name: selectedFile.name })}
              </p>
            )}
            {fileOutcome && <AddOutcomeNote outcome={fileOutcome} />}
          </div>
        </section>
      )}
    </>
  );
}
