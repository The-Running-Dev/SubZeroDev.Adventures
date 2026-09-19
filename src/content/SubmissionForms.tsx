import { useTranslation } from "react-i18next";
import type { useMyContent } from "./useMyContent";
import { OutcomeNote } from "./OutcomeNote";
export function SubmissionForms({
  online,
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
  handleAddUrl,
  handleAddPaste,
  handleAddFile,
}: ReturnType<typeof useMyContent>) {
  const { t } = useTranslation("content");
  return (
    <section className="admin-block">
      <h2 className="admin-heading">{t("submit")}</h2>

      <div className="admin-form">
        <h3 className="admin-subheading">{t("urlSource")}</h3>
        <div className="admin-form-row">
          <input
            type="text"
            aria-label={t("label")}
            placeholder={t("label")}
            value={urlLabel}
            onChange={(event) => setUrlLabel(event.target.value)}
          />
          <input
            type="text"
            aria-label={t("sourceUrl")}
            placeholder="https://…/campaigns/"
            value={urlValue}
            onChange={(event) => setUrlValue(event.target.value)}
          />
          <button
            type="button"
            className="admin-sync"
            onClick={() => void handleAddUrl()}
            disabled={!online || addingUrl || !urlLabel || !urlValue}
          >
            {addingUrl ? t("adding") : t("add")}
          </button>
        </div>
        {urlOutcome && <OutcomeNote outcome={urlOutcome} />}
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
        />
        <div className="admin-form-row">
          <button
            type="button"
            className="admin-sync"
            onClick={() => void handleAddPaste()}
            disabled={!online || addingPaste || !pasteText.trim()}
          >
            {addingPaste ? t("adding") : t("add")}
          </button>
        </div>
        {pasteOutcome && <OutcomeNote outcome={pasteOutcome} />}
      </div>

      <div className="admin-form">
        <h3 className="admin-subheading">{t("uploadTitle")}</h3>
        <div className="admin-form-row">
          <label className="admin-file-label" htmlFor="content-json-file">
            {t("file")}
          </label>
          <input
            ref={fileInput}
            id="content-json-file"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              setSelectedFile(event.target.files?.[0]);
              setFileOutcome(undefined);
            }}
            disabled={!online || addingFile}
          />
          <button
            type="button"
            className="admin-sync"
            onClick={() => void handleAddFile()}
            disabled={!online || !selectedFile || addingFile}
          >
            {addingFile ? t("uploading") : t("upload")}
          </button>
        </div>
        {selectedFile && (
          <p className="admin-file-name" role="status">
            {t("selected", { name: selectedFile.name })}
          </p>
        )}
        {fileOutcome && <OutcomeNote outcome={fileOutcome} />}
      </div>
    </section>
  );
}
