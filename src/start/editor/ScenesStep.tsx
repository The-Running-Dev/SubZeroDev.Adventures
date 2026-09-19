import { useTranslation } from "react-i18next";
import {
  emptyNode,
  isContentId,
  type CampaignDraft,
  type DraftNode,
} from "../draft";
import { Field } from "./Field";
import { ChoiceEditor } from "./ChoiceEditor";

export function ScenesStep({
  draft,
  setDraft,
  update,
}: {
  readonly draft: CampaignDraft;
  readonly setDraft: React.Dispatch<React.SetStateAction<CampaignDraft>>;
  readonly update: (patch: Partial<CampaignDraft>) => void;
}) {
  const { t } = useTranslation("creator");
  function patchNode(index: number, change: Partial<DraftNode>): void {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node, i) =>
        i === index ? { ...node, ...change } : node,
      ),
    }));
  }

  const nodeIds = draft.nodes.map((node) => node.id);

  return (
    <div className="gs-form">
      <Field label={t("opening")} hint={t("openingHint")}>
        <select
          value={draft.startNodeId}
          onChange={(event) => update({ startNodeId: event.target.value })}
        >
          {nodeIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </Field>

      {draft.nodes.map((node, index) => (
        <fieldset className="gs-group" key={index}>
          <legend>
            {node.id || t("unnamedScene")} · {t(node.kind)}
          </legend>

          <div className="gs-row">
            <Field
              label={t("sceneId")}
              hint={
                node.id === "" || isContentId(node.id)
                  ? undefined
                  : t("contentIdHint")
              }
            >
              <input
                type="text"
                value={node.id}
                onChange={(event) =>
                  patchNode(index, { id: event.target.value })
                }
              />
            </Field>
            <Field label={t("kind")}>
              <select
                value={t(node.kind)}
                onChange={(event) =>
                  patchNode(index, {
                    kind: event.target.value as DraftNode["kind"],
                  })
                }
              >
                <option value="choice">{t("choice")}</option>
                <option value="ending">{t("ending")}</option>
              </select>
            </Field>
          </div>

          <Field label={t("sceneText")}>
            <textarea
              rows={4}
              value={node.text}
              onChange={(event) =>
                patchNode(index, { text: event.target.value })
              }
            />
          </Field>

          {node.kind === "ending" ? (
            <div className="gs-row">
              <Field label={t("endingId")} hint={t("endingHint")}>
                <input
                  type="text"
                  value={node.endingId}
                  onChange={(event) =>
                    patchNode(index, { endingId: event.target.value })
                  }
                />
              </Field>
              <Field label={t("outcome")}>
                <select
                  value={node.outcome}
                  onChange={(event) =>
                    patchNode(index, {
                      outcome: event.target.value as DraftNode["outcome"],
                    })
                  }
                >
                  <option value="neutral">{t("neutral")}</option>
                  <option value="win">{t("win")}</option>
                  <option value="loss">{t("loss")}</option>
                </select>
              </Field>
            </div>
          ) : (
            <ChoiceEditor
              node={node}
              nodeIds={nodeIds}
              variables={draft.variables}
              onChange={(choices) => patchNode(index, { choices })}
            />
          )}

          <button
            type="button"
            className="gs-btn"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                nodes: current.nodes.filter((_, i) => i !== index),
              }))
            }
            disabled={draft.nodes.length === 1}
          >
            {t("removeScene")}
          </button>
        </fieldset>
      ))}

      <div className="gs-actions">
        <button
          type="button"
          className="gs-btn gs-btn-primary"
          onClick={() =>
            setDraft((current) => ({
              ...current,
              nodes: [
                ...current.nodes,
                emptyNode(`scene_${current.nodes.length + 1}`, "choice"),
              ],
            }))
          }
        >
          {t("addScene")}
        </button>
        <button
          type="button"
          className="gs-btn"
          onClick={() =>
            setDraft((current) => ({
              ...current,
              nodes: [
                ...current.nodes,
                emptyNode(`ending_${current.nodes.length + 1}`, "ending"),
              ],
            }))
          }
        >
          {t("addEnding")}
        </button>
      </div>
    </div>
  );
}
