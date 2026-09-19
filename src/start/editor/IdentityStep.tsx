import { useTranslation } from "react-i18next";
import { useState } from "react";
import { isKebabCase, slugify, type CampaignDraft } from "../draft";
import { Field } from "./Field";

function SampleLoader({
  hasWork,
  onLoad,
}: {
  readonly hasWork: boolean;
  readonly onLoad: () => void;
}) {
  const { t } = useTranslation("creator");
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="gs-group">
      <p className="gs-prose">{t("sampleIntro")}</p>
      {confirming ? (
        <>
          <p className="gs-note" role="alert">
            {t("replaceWarning")}
          </p>
          <div className="gs-actions">
            <button
              type="button"
              className="gs-btn gs-btn-primary"
              onClick={() => {
                setConfirming(false);
                onLoad();
              }}
            >
              {t("replace")}
            </button>
            <button
              type="button"
              className="gs-btn"
              onClick={() => setConfirming(false)}
            >
              {t("keep")}
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="gs-btn"
          onClick={() => (hasWork ? setConfirming(true) : onLoad())}
        >
          {t("sample")}
        </button>
      )}
    </div>
  );
}

export function IdentityStep({
  draft,
  update,
  hasWork,
  onLoadSample,
}: {
  readonly draft: CampaignDraft;
  readonly update: (patch: Partial<CampaignDraft>) => void;
  readonly hasWork: boolean;
  readonly onLoadSample: () => void;
}) {
  const { t } = useTranslation("creator");
  return (
    <div className="gs-form">
      <SampleLoader hasWork={hasWork} onLoad={onLoadSample} />
      <Field label={t("title")}>
        <input
          type="text"
          value={draft.title}
          onChange={(event) => {
            const title = event.target.value;
            // The id follows the title only while the author has not set one themselves --
            // changing it later would rename every string key mid-draft.
            update(
              draft.id === "" || draft.id === slugify(draft.title)
                ? { title, id: slugify(title) }
                : { title },
            );
          }}
        />
      </Field>
      <Field
        label={t("campaignId")}
        hint={
          draft.id === "" || isKebabCase(draft.id)
            ? t("idHint")
            : t("idInvalid")
        }
      >
        <input
          type="text"
          value={draft.id}
          onChange={(event) => update({ id: event.target.value })}
        />
      </Field>
      <Field label={t("description")}>
        <textarea
          rows={3}
          value={draft.description}
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>
      <Field label={t("duration")} hint={t("durationHint")}>
        <input
          type="text"
          value={draft.duration}
          onChange={(event) => update({ duration: event.target.value })}
        />
      </Field>
      <Field label={t("notice")} hint={t("noticeHint")}>
        <input
          type="text"
          value={draft.contentNotice}
          onChange={(event) => update({ contentNotice: event.target.value })}
        />
      </Field>
      <Field label={t("version")}>
        <input
          type="text"
          value={draft.version}
          onChange={(event) => update({ version: event.target.value })}
        />
      </Field>
    </div>
  );
}
