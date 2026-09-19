import { useTranslation } from "react-i18next";
import {
  emptyVariable,
  isContentId,
  type CampaignDraft,
  type DraftVariable,
} from "../draft";
import { Field } from "./Field";

export function StatsStep({
  draft,
  setDraft,
}: {
  readonly draft: CampaignDraft;
  readonly setDraft: React.Dispatch<React.SetStateAction<CampaignDraft>>;
}) {
  const { t } = useTranslation("creator");
  function patch(index: number, change: Partial<DraftVariable>): void {
    setDraft((current) => ({
      ...current,
      variables: current.variables.map((variable, i) =>
        i === index ? { ...variable, ...change } : variable,
      ),
    }));
  }

  return (
    <div className="gs-form">
      <p className="gs-prose">
        {t("statsIntro")} <code>{"{name}"}</code>.
      </p>

      {draft.variables.map((variable, index) => (
        <fieldset className="gs-group" key={index}>
          <legend>{variable.name || t("unnamedStat")}</legend>
          <div className="gs-row">
            <Field
              label={t("name")}
              hint={
                variable.name === "" || isContentId(variable.name)
                  ? undefined
                  : t("contentIdHint")
              }
            >
              <input
                type="text"
                value={variable.name}
                onChange={(event) => patch(index, { name: event.target.value })}
              />
            </Field>
            <Field label={t("type")}>
              <select
                value={variable.type}
                onChange={(event) =>
                  patch(index, {
                    type: event.target.value as DraftVariable["type"],
                  })
                }
              >
                <option value="int">{t("integer")}</option>
                <option value="bool">{t("boolean")}</option>
                <option value="enum">{t("enum")}</option>
              </select>
            </Field>
            <Field label={t("startsAt")}>
              <input
                type="text"
                value={variable.initial}
                onChange={(event) =>
                  patch(index, { initial: event.target.value })
                }
              />
            </Field>
          </div>

          {variable.type === "enum" && (
            <Field label={t("allowedValues")} hint={t("commaSeparated")}>
              <input
                type="text"
                value={variable.values}
                onChange={(event) =>
                  patch(index, { values: event.target.value })
                }
              />
            </Field>
          )}
          {variable.type === "int" && (
            <div className="gs-row">
              <Field label={t("minimum")} hint={t("minimumHint")}>
                <input
                  type="text"
                  value={variable.min}
                  onChange={(event) =>
                    patch(index, { min: event.target.value })
                  }
                />
              </Field>
              <Field label={t("maximum")} hint={t("maximumHint")}>
                <input
                  type="text"
                  value={variable.max}
                  onChange={(event) =>
                    patch(index, { max: event.target.value })
                  }
                />
              </Field>
            </div>
          )}

          <div className="gs-row">
            <label className="gs-check-field">
              <input
                type="checkbox"
                checked={variable.visible}
                onChange={(event) =>
                  patch(index, { visible: event.target.checked })
                }
              />
              {t("visible")}
            </label>
            {variable.visible && (
              <Field label={t("label")}>
                <input
                  type="text"
                  value={variable.label}
                  onChange={(event) =>
                    patch(index, { label: event.target.value })
                  }
                />
              </Field>
            )}
          </div>

          <button
            type="button"
            className="gs-btn"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                variables: current.variables.filter((_, i) => i !== index),
              }))
            }
          >
            {t("removeStat")}
          </button>
        </fieldset>
      ))}

      <button
        type="button"
        className="gs-btn gs-btn-primary"
        onClick={() =>
          setDraft((current) => ({
            ...current,
            variables: [
              ...current.variables,
              emptyVariable(`stat_${current.variables.length + 1}`),
            ],
          }))
        }
      >
        {t("addStat")}
      </button>
    </div>
  );
}
