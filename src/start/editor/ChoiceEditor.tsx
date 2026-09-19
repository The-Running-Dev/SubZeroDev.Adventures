import { useTranslation } from "react-i18next";
import type { DraftNode, DraftVariable } from "../draft";
import { Field } from "./Field";
import { EffectEditor } from "./EffectEditor";

export function ChoiceEditor({
  node,
  nodeIds,
  variables,
  onChange,
}: {
  readonly node: DraftNode;
  readonly nodeIds: readonly string[];
  readonly variables: readonly DraftVariable[];
  readonly onChange: (choices: DraftNode["choices"]) => void;
}) {
  const { t } = useTranslation("creator");
  function patch(index: number, change: Partial<DraftNode["choices"][number]>) {
    onChange(
      node.choices.map((choice, i) =>
        i === index ? { ...choice, ...change } : choice,
      ),
    );
  }

  return (
    <div className="gs-choices">
      {node.choices.map((choice, index) => (
        <div className="gs-choice" key={index}>
          <div className="gs-row">
            <Field label={t("choiceId")}>
              <input
                type="text"
                value={choice.id}
                onChange={(event) => patch(index, { id: event.target.value })}
              />
            </Field>
            <Field label={t("choiceText")}>
              <input
                type="text"
                value={choice.label}
                onChange={(event) =>
                  patch(index, { label: event.target.value })
                }
              />
            </Field>
            <Field label={t("leadsTo")}>
              <select
                value={choice.goto}
                onChange={(event) => patch(index, { goto: event.target.value })}
              >
                <option value="">{t("pickScene")}</option>
                {nodeIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {variables.length > 0 && (
            <EffectEditor
              effects={choice.effects}
              variables={variables}
              onChange={(effects) => patch(index, { effects })}
            />
          )}

          <button
            type="button"
            className="gs-btn"
            onClick={() => onChange(node.choices.filter((_, i) => i !== index))}
            disabled={node.choices.length === 1}
          >
            {t("removeChoice")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="gs-btn"
        onClick={() =>
          onChange([
            ...node.choices,
            {
              id: `choice_${node.choices.length + 1}`,
              label: "",
              goto: "",
              effects: [],
            },
          ])
        }
      >
        {t("addChoice")}
      </button>
    </div>
  );
}
