import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  emptyAchievement,
  type CampaignDraft,
  type DraftAchievement,
} from "../draft";
import { Field } from "./Field";

export function RewardsStep({
  draft,
  setDraft,
}: {
  readonly draft: CampaignDraft;
  readonly setDraft: React.Dispatch<React.SetStateAction<CampaignDraft>>;
}) {
  const { t } = useTranslation("creator");
  const endingIds = draft.nodes
    .filter((node) => node.kind === "ending" && node.endingId !== "")
    .map((node) => node.endingId);

  function patch(index: number, change: Partial<DraftAchievement>): void {
    setDraft((current) => ({
      ...current,
      achievements: current.achievements.map((achievement, i) =>
        i === index ? { ...achievement, ...change } : achievement,
      ),
    }));
  }

  return (
    <div className="gs-form">
      <p className="gs-prose">
        {t("rewardsIntro")} <Link to="/content">{t("myContent")}</Link>.
      </p>

      {endingIds.length === 0 && <p className="gs-note">{t("endingFirst")}</p>}

      {draft.achievements.map((achievement, index) => (
        <fieldset className="gs-group" key={index}>
          <legend>{achievement.id || t("unnamedReward")}</legend>
          <div className="gs-row">
            <Field label={t("rewardId")}>
              <input
                type="text"
                value={achievement.id}
                onChange={(event) => patch(index, { id: event.target.value })}
              />
            </Field>
            <Field label={t("unlocksOn")}>
              <select
                value={achievement.endingId}
                onChange={(event) =>
                  patch(index, { endingId: event.target.value })
                }
              >
                <option value="">{t("pickEnding")}</option>
                {endingIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t("name")}>
            <input
              type="text"
              value={achievement.name}
              onChange={(event) => patch(index, { name: event.target.value })}
            />
          </Field>
          <Field label={t("description")}>
            <input
              type="text"
              value={achievement.description}
              onChange={(event) =>
                patch(index, { description: event.target.value })
              }
            />
          </Field>
          <label className="gs-check-field">
            <input
              type="checkbox"
              checked={achievement.hidden}
              onChange={(event) =>
                patch(index, { hidden: event.target.checked })
              }
            />
            {t("hide")}
          </label>
          <button
            type="button"
            className="gs-btn"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                achievements: current.achievements.filter(
                  (_, i) => i !== index,
                ),
              }))
            }
          >
            {t("removeReward")}
          </button>
        </fieldset>
      ))}

      <button
        type="button"
        className="gs-btn gs-btn-primary"
        disabled={endingIds.length === 0}
        onClick={() =>
          setDraft((current) => ({
            ...current,
            achievements: [
              ...current.achievements,
              emptyAchievement(`reward_${current.achievements.length + 1}`),
            ],
          }))
        }
      >
        {t("addReward")}
      </button>
    </div>
  );
}
