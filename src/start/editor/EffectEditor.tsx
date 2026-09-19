import { useTranslation } from "react-i18next";
import type { DraftEffect, DraftVariable } from "../draft";
import { Field } from "./Field";

export function EffectEditor({
  effects,
  variables,
  onChange,
}: {
  readonly effects: readonly DraftEffect[];
  readonly variables: readonly DraftVariable[];
  readonly onChange: (effects: readonly DraftEffect[]) => void;
}) {
  const { t } = useTranslation("creator");
  return (
    <div className="gs-effects">
      {effects.map((effect, index) => (
        <div className="gs-row" key={index}>
          <Field label={t("changes")}>
            <select
              value={effect.variable}
              onChange={(event) =>
                onChange(
                  effects.map((current, i) =>
                    i === index
                      ? { ...current, variable: event.target.value }
                      : current,
                  ),
                )
              }
            >
              <option value="">{t("pickStat")}</option>
              {variables.map((variable) => (
                <option key={variable.name} value={variable.name}>
                  {variable.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("how")}>
            <select
              value={effect.op}
              onChange={(event) =>
                onChange(
                  effects.map((current, i) =>
                    i === index
                      ? {
                          ...current,
                          op: event.target.value as DraftEffect["op"],
                        }
                      : current,
                  ),
                )
              }
            >
              <option value="set">{t("set")}</option>
              <option value="increment">{t("increment")}</option>
              <option value="decrement">{t("decrement")}</option>
            </select>
          </Field>
          <Field label={t("value")}>
            <input
              type="text"
              value={effect.value}
              onChange={(event) =>
                onChange(
                  effects.map((current, i) =>
                    i === index
                      ? { ...current, value: event.target.value }
                      : current,
                  ),
                )
              }
            />
          </Field>
          <button
            type="button"
            className="gs-btn"
            onClick={() => onChange(effects.filter((_, i) => i !== index))}
          >
            {t("remove")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="gs-btn"
        onClick={() =>
          onChange([...effects, { variable: "", op: "set", value: "" }])
        }
      >
        {t("addEffect")}
      </button>
    </div>
  );
}
