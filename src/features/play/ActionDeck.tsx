import { useTranslation } from "react-i18next";
import type { PlayState } from "../../play/browser-client";
export function ActionDeck({
  actions,
  busy,
  terminal,
  bbsSigil,
  onChoose,
}: {
  actions: PlayState["actions"];
  busy: boolean;
  terminal: boolean;
  bbsSigil: string;
  onChoose: (id: string) => void;
}) {
  const { t } = useTranslation("play");
  return (
    <div className="action-deck" aria-label={t("actions")} aria-busy={busy}>
      <p className="deck-label">
        {terminal && `${bbsSigil} `}
        {t("whatNext")}
      </p>
      {actions.map((action, index) => (
        <div
          className={`action-card ${!action.available ? "unavailable" : ""}`}
          key={action.id}
        >
          <button
            disabled={busy || !action.available}
            onClick={() => onChoose(action.id)}
          >
            <span className="action-number" aria-hidden="true">
              {index + 1}
            </span>
            {action.label}
          </button>
          {!action.available && (
            <p className="play-reason">
              {t("unavailable", { reason: action.reason })}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
