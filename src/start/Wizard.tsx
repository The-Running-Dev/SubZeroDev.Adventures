import { useTranslation } from "react-i18next";
/** Owns the durable draft and active playtest; editors own only presentation. */
import { useEffect, useState } from "react";
import {
  clearDraft,
  draftDigest,
  emptyDraft,
  loadDraft,
  saveDraft,
  type CampaignDraft,
} from "./draft";
import { useDraftValidation } from "./draft-validation";
import { useDraftPlaytest } from "./draft-playtest";
import { Playtest } from "./Playtest";
import { sampleDraft } from "./sample";
import { IdentityStep } from "./editor/IdentityStep";
import { StatsStep } from "./editor/StatsStep";
import { ScenesStep } from "./editor/ScenesStep";
import { RewardsStep } from "./editor/RewardsStep";
import { SubmitStep } from "./editor/SubmitStep";
import { ValidationConsole } from "./editor/ValidationConsole";

const STEPS = [
  { id: "identity", key: "1", label: "Identity" },
  { id: "stats", key: "2", label: "Stats" },
  { id: "scenes", key: "3", label: "Scenes" },
  { id: "rewards", key: "4", label: "Rewards" },
  { id: "playtest", key: "5", label: "Playtest" },
  { id: "submit", key: "6", label: "Submit" },
] as const;

const PLAYTEST_STEP = STEPS.findIndex((step) => step.id === "playtest");

/** What an untouched draft digests to. Computed once, from `emptyDraft` itself, so "has the
 *  author written anything?" cannot drift from what `emptyDraft` actually returns -- and so a
 *  draft edited back to empty counts as empty, which is the answer the author expects. */
const EMPTY_DIGEST = draftDigest(emptyDraft());

interface WizardProps {
  readonly apiUrl?: string;
  /** Returns to `/start`'s own menu -- the wizard is a door off that page, not a route. */
  readonly onExit: () => void;
}

export function Wizard({ apiUrl, onExit }: WizardProps) {
  const { t } = useTranslation("creator");
  /**
   * Read synchronously, as lazy initial state, and not in a mount effect.
   *
   * This is load-bearing, not a style preference. With the read in an effect, the *save*
   * effect below runs in the same commit -- effects fire in declaration order, and the load's
   * `setDraft` has not been applied yet -- so it writes the empty draft over the author's
   * stored one. Under StrictMode's double invocation the second load then reads back that
   * empty draft, whose shape is entirely valid, and the author's work is gone on reload with
   * nothing to indicate it ever existed.
   */
  const [draft, setDraft] = useState<CampaignDraft>(
    () => loadDraft() ?? emptyDraft(),
  );
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    saveDraft(draft);
  }, [draft]);

  const validation = useDraftValidation(draft);
  // Held here rather than inside `<Playtest>`: the panel unmounts whenever the author leaves
  // its step, which is precisely when an edit invalidates the run it was showing.
  const playtest = useDraftPlaytest(draft);
  const step = STEPS[stepIndex]!;

  function update(patch: Partial<CampaignDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  return (
    <div className="gs-dialog gs-wizard">
      <h1 id="start-title" className="gs-dialog-title">
        {t("authoring", { step: t(step.id).toUpperCase() })}
      </h1>

      <nav className="gs-menu gs-wizard-steps" aria-label={t("steps")}>
        {STEPS.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            className="gs-menu-row"
            aria-current={index === stepIndex ? "step" : undefined}
            onClick={() => setStepIndex(index)}
          >
            {/* The explicit spaces are the accessible name: adjacent JSX elements
                concatenate with nothing between them, so without these a screen reader
                announces this step as "5)Playtest". */}
            <span className="gs-menu-key">{entry.key})</span>{" "}
            <span className="gs-menu-label">{t(entry.id)}</span>
          </button>
        ))}
      </nav>

      <div className="gs-dialog-body">
        {step.id === "identity" && (
          <IdentityStep
            draft={draft}
            update={update}
            hasWork={draftDigest(draft) !== EMPTY_DIGEST}
            onLoadSample={() => {
              setDraft(sampleDraft());
              // Straight to the playtest step: the sample is complete apart from its name,
              // so the useful next act is running it, not reading six steps of empty form.
              setStepIndex(PLAYTEST_STEP);
            }}
          />
        )}
        {step.id === "stats" && <StatsStep draft={draft} setDraft={setDraft} />}
        {step.id === "scenes" && (
          <ScenesStep draft={draft} setDraft={setDraft} update={update} />
        )}
        {step.id === "rewards" && (
          <RewardsStep draft={draft} setDraft={setDraft} />
        )}
        {step.id === "playtest" && (
          <Playtest session={playtest} playable={validation.ok} />
        )}
        {step.id === "submit" && (
          <SubmitStep
            draft={draft}
            apiUrl={apiUrl}
            valid={validation.ok}
            onSubmitted={() => {
              clearDraft();
              setDraft(emptyDraft());
              setStepIndex(0);
            }}
          />
        )}
      </div>

      <ValidationConsole validation={validation} />

      <div className="gs-legend">
        <button type="button" className="gs-legend-btn" onClick={onExit}>
          {t("menu")}
        </button>
        <div className="gs-actions">
          <button
            type="button"
            className="gs-legend-btn"
            onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
            disabled={stepIndex === 0}
          >
            {t("back")}
          </button>
          <button
            type="button"
            className="gs-legend-btn"
            onClick={() =>
              setStepIndex((index) => Math.min(STEPS.length - 1, index + 1))
            }
            disabled={stepIndex === STEPS.length - 1}
          >
            {t("next")}
          </button>
        </div>
      </div>
    </div>
  );
}
