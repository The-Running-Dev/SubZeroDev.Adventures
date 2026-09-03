/**
 * The campaign-authoring wizard.
 *
 * A linear step machine over one `CampaignDraft` (`draft.ts`), which it keeps in this
 * browser and projects to a `PortableCampaign` on every edit. Two things it deliberately
 * does not do:
 *
 *  - **It does not gate steps on engine validity.** A story graph is invalid for most of its
 *    authoring life -- the first choice points at a scene that has not been written yet --
 *    so validation runs continuously and is *shown* continuously, in the console panel, and
 *    only playtest and submit are gated on it. See `draft-validation.ts` for the longer form
 *    of that argument.
 *  - **It does not persist anything server-side.** The draft lives in `localStorage` until
 *    it is submitted, at which point it leaves through the existing `/api/content` `"pasted"`
 *    flow as one payload -- same route, same trust tier, same review queue as pasting the
 *    JSON by hand on `/content`. No new server surface exists for authoring.
 */
import { useEffect, useState } from "react";
import { useIdentity } from "../play/identity";
import {
  clearDraft,
  draftDigest,
  emptyAchievement,
  emptyDraft,
  emptyNode,
  emptyVariable,
  isContentId,
  isKebabCase,
  loadDraft,
  saveDraft,
  slugify,
  toPortableCampaign,
  type CampaignDraft,
  type DraftAchievement,
  type DraftEffect,
  type DraftNode,
  type DraftVariable,
} from "./draft";
import { describeFinding, useDraftValidation } from "./draft-validation";
import { useDraftPlaytest } from "./draft-playtest";
import { Playtest } from "./Playtest";
import { sampleDraft } from "./sample";

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
      <div className="gs-dialog-title">
        CAMPAIGN AUTHORING — {step.label.toUpperCase()}
      </div>

      <nav className="gs-menu gs-wizard-steps" aria-label="Authoring steps">
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
            <span className="gs-menu-label">{entry.label}</span>
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
          F3 MENU
        </button>
        <div className="gs-actions">
          <button
            type="button"
            className="gs-legend-btn"
            onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
            disabled={stepIndex === 0}
          >
            ESC BACK
          </button>
          <button
            type="button"
            className="gs-legend-btn"
            onClick={() =>
              setStepIndex((index) => Math.min(STEPS.length - 1, index + 1))
            }
            disabled={stepIndex === STEPS.length - 1}
          >
            ENTER CONTINUE
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The validation console -- always on screen, never blocking
// ---------------------------------------------------------------------------

function ValidationConsole({
  validation,
}: {
  readonly validation: ReturnType<typeof useDraftValidation>;
}) {
  const { ok, errors, warnings, fatal } = validation;
  return (
    <section className="gs-console" aria-label="Validation">
      <p className="gs-eyebrow gs-amber">
        VALIDATION —{" "}
        {ok
          ? "passes; ready to play and submit"
          : `${errors.length + (fatal ? 1 : 0)} to fix`}
      </p>
      <ul className="gs-checks">
        {fatal && (
          <li className="gs-check gs-check-todo">
            <span aria-hidden="true">[ ]</span> {fatal}
          </li>
        )}
        {errors.map((error, index) => (
          <li key={`e${index}`} className="gs-check gs-check-todo">
            <span aria-hidden="true">[ ]</span> {describeFinding(error)}
          </li>
        ))}
        {warnings.map((warning, index) => (
          <li key={`w${index}`} className="gs-check gs-check-locked">
            <span aria-hidden="true">[–]</span> {describeFinding(warning)}
          </li>
        ))}
        {ok && warnings.length === 0 && (
          <li className="gs-check gs-check-done">
            <span aria-hidden="true">[×]</span> No findings.
          </li>
        )}
      </ul>
      {warnings.length > 0 && (
        <p className="gs-dim">
          Bracketed findings are warnings — the campaign still loads and still
          submits with them.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="gs-field">
      <span className="gs-field-label">{label}</span>
      {children}
      {hint && <span className="gs-dim gs-field-hint">{hint}</span>}
    </label>
  );
}

/**
 * The blank-or-sample fork, offered on the first step rather than as a step of its own.
 *
 * The wizard already opens blank, so a pre-step asking "blank or sample?" would put a screen
 * in front of every author who wanted the blank one -- which is most of them, on every return
 * visit. Offering the sample here costs the blank path nothing and is on screen at the only
 * moment it is useful.
 */
function SampleLoader({
  hasWork,
  onLoad,
}: {
  readonly hasWork: boolean;
  readonly onLoad: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="gs-group">
      <p className="gs-prose">
        Blank is a fine place to start. If you would rather take something apart
        than face an empty form, load the sample — three scenes, one visible
        stat and two endings, in the same shapes this wizard edits. It opens on
        the playtest step, and runs as soon as you give it a name.
      </p>
      {confirming ? (
        <>
          <p className="gs-note" role="alert">
            This replaces the draft you already have. It is kept only in this
            browser, so there is no copy to go back to.
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
              REPLACE MY DRAFT ▸
            </button>
            <button
              type="button"
              className="gs-btn"
              onClick={() => setConfirming(false)}
            >
              Keep what I have
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="gs-btn"
          onClick={() => (hasWork ? setConfirming(true) : onLoad())}
        >
          START FROM A SAMPLE ▸
        </button>
      )}
    </div>
  );
}

function IdentityStep({
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
  return (
    <div className="gs-form">
      <SampleLoader hasWork={hasWork} onLoad={onLoadSample} />
      <Field label="Title">
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
        label="Campaign id"
        hint={
          draft.id === "" || isKebabCase(draft.id)
            ? "Lower-case words joined by hyphens. Also prefixes every text key, so it has to be unique across the whole catalog."
            : "Must be lower-case words joined by hyphens."
        }
      >
        <input
          type="text"
          value={draft.id}
          onChange={(event) => update({ id: event.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          rows={3}
          value={draft.description}
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>
      <Field label="Duration" hint="Shown on the shelf card, e.g. “~10 min”.">
        <input
          type="text"
          value={draft.duration}
          onChange={(event) => update({ duration: event.target.value })}
        />
      </Field>
      <Field
        label="Content notice"
        hint="What a reader should know before starting. Leave blank if there is nothing to flag."
      >
        <input
          type="text"
          value={draft.contentNotice}
          onChange={(event) => update({ contentNotice: event.target.value })}
        />
      </Field>
      <Field label="Version">
        <input
          type="text"
          value={draft.version}
          onChange={(event) => update({ version: event.target.value })}
        />
      </Field>
    </div>
  );
}

function StatsStep({
  draft,
  setDraft,
}: {
  readonly draft: CampaignDraft;
  readonly setDraft: React.Dispatch<React.SetStateAction<CampaignDraft>>;
}) {
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
        Stats are optional. A visible one is shown to the player and is the only
        kind a scene’s text may interpolate, as <code>{"{name}"}</code>.
      </p>

      {draft.variables.map((variable, index) => (
        <fieldset className="gs-group" key={index}>
          <legend>{variable.name || "unnamed stat"}</legend>
          <div className="gs-row">
            <Field
              label="Name"
              hint={
                variable.name === "" || isContentId(variable.name)
                  ? undefined
                  : "Lower-case letters, digits and underscores."
              }
            >
              <input
                type="text"
                value={variable.name}
                onChange={(event) => patch(index, { name: event.target.value })}
              />
            </Field>
            <Field label="Type">
              <select
                value={variable.type}
                onChange={(event) =>
                  patch(index, {
                    type: event.target.value as DraftVariable["type"],
                  })
                }
              >
                <option value="int">whole number</option>
                <option value="bool">true / false</option>
                <option value="enum">one of a set</option>
              </select>
            </Field>
            <Field label="Starts at">
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
            <Field label="Allowed values" hint="Comma separated.">
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
              <Field label="Minimum" hint="Blank for no floor.">
                <input
                  type="text"
                  value={variable.min}
                  onChange={(event) =>
                    patch(index, { min: event.target.value })
                  }
                />
              </Field>
              <Field label="Maximum" hint="Blank for no ceiling.">
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
              Show to the player
            </label>
            {variable.visible && (
              <Field label="Label">
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
            Remove stat
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
        ADD A STAT ▸
      </button>
    </div>
  );
}

function ScenesStep({
  draft,
  setDraft,
  update,
}: {
  readonly draft: CampaignDraft;
  readonly setDraft: React.Dispatch<React.SetStateAction<CampaignDraft>>;
  readonly update: (patch: Partial<CampaignDraft>) => void;
}) {
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
      <Field label="Opening scene" hint="Where every run starts.">
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
            {node.id || "unnamed scene"} · {node.kind}
          </legend>

          <div className="gs-row">
            <Field
              label="Scene id"
              hint={
                node.id === "" || isContentId(node.id)
                  ? undefined
                  : "Lower-case letters, digits and underscores."
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
            <Field label="Kind">
              <select
                value={node.kind}
                onChange={(event) =>
                  patchNode(index, {
                    kind: event.target.value as DraftNode["kind"],
                  })
                }
              >
                <option value="choice">offers choices</option>
                <option value="ending">ends the run</option>
              </select>
            </Field>
          </div>

          <Field label="Scene text">
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
              <Field
                label="Ending id"
                hint="What rewards match on, and what the shelf counts as a distinct ending."
              >
                <input
                  type="text"
                  value={node.endingId}
                  onChange={(event) =>
                    patchNode(index, { endingId: event.target.value })
                  }
                />
              </Field>
              <Field label="Outcome">
                <select
                  value={node.outcome}
                  onChange={(event) =>
                    patchNode(index, {
                      outcome: event.target.value as DraftNode["outcome"],
                    })
                  }
                >
                  <option value="neutral">neutral</option>
                  <option value="win">win</option>
                  <option value="loss">loss</option>
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
            Remove scene
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
          ADD A SCENE ▸
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
          ADD AN ENDING ▸
        </button>
      </div>
    </div>
  );
}

function ChoiceEditor({
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
            <Field label="Choice id">
              <input
                type="text"
                value={choice.id}
                onChange={(event) => patch(index, { id: event.target.value })}
              />
            </Field>
            <Field label="Choice text">
              <input
                type="text"
                value={choice.label}
                onChange={(event) =>
                  patch(index, { label: event.target.value })
                }
              />
            </Field>
            <Field label="Leads to">
              <select
                value={choice.goto}
                onChange={(event) => patch(index, { goto: event.target.value })}
              >
                <option value="">— pick a scene —</option>
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
            Remove choice
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
        Add a choice
      </button>
    </div>
  );
}

function EffectEditor({
  effects,
  variables,
  onChange,
}: {
  readonly effects: readonly DraftEffect[];
  readonly variables: readonly DraftVariable[];
  readonly onChange: (effects: readonly DraftEffect[]) => void;
}) {
  return (
    <div className="gs-effects">
      {effects.map((effect, index) => (
        <div className="gs-row" key={index}>
          <Field label="Changes">
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
              <option value="">— pick a stat —</option>
              {variables.map((variable) => (
                <option key={variable.name} value={variable.name}>
                  {variable.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How">
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
              <option value="set">set to</option>
              <option value="increment">add</option>
              <option value="decrement">subtract</option>
            </select>
          </Field>
          <Field label="Value">
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
            Remove
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
        Add an effect
      </button>
    </div>
  );
}

function RewardsStep({
  draft,
  setDraft,
}: {
  readonly draft: CampaignDraft;
  readonly setDraft: React.Dispatch<React.SetStateAction<CampaignDraft>>;
}) {
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
        Rewards are optional, and unlock when a player reaches a particular
        ending. Richer conditions exist in the format — they are not authored
        here; a campaign that needs them can be pasted as JSON on{" "}
        <a href="/content">My content</a>.
      </p>

      {endingIds.length === 0 && (
        <p className="gs-note">
          Write an ending first — a reward has to point at one.
        </p>
      )}

      {draft.achievements.map((achievement, index) => (
        <fieldset className="gs-group" key={index}>
          <legend>{achievement.id || "unnamed reward"}</legend>
          <div className="gs-row">
            <Field label="Reward id">
              <input
                type="text"
                value={achievement.id}
                onChange={(event) => patch(index, { id: event.target.value })}
              />
            </Field>
            <Field label="Unlocks on ending">
              <select
                value={achievement.endingId}
                onChange={(event) =>
                  patch(index, { endingId: event.target.value })
                }
              >
                <option value="">— pick an ending —</option>
                {endingIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Name">
            <input
              type="text"
              value={achievement.name}
              onChange={(event) => patch(index, { name: event.target.value })}
            />
          </Field>
          <Field label="Description">
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
            Hide until unlocked
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
            Remove reward
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
        ADD A REWARD ▸
      </button>
    </div>
  );
}

function SubmitStep({
  draft,
  apiUrl,
  valid,
  onSubmitted,
}: {
  readonly draft: CampaignDraft;
  readonly apiUrl?: string;
  readonly valid: boolean;
  readonly onSubmitted: () => void;
}) {
  const { identity, loading } = useIdentity(apiUrl, 0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{
    readonly tone: "ok" | "error";
    readonly text: string;
  }>();

  const signedIn = !loading && identity.kind !== "anonymous";

  async function submit(): Promise<void> {
    setBusy(true);
    setOutcome(undefined);
    try {
      // The same request `MyContent.tsx`'s paste form sends. Nothing about an authored draft
      // makes it a different kind of submission, so it does not get a different route: it
      // inherits the submission tier's fail-open quarantine and the review queue as they are.
      const response = await fetch(`${apiUrl}/api/content`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pasted",
          label: draft.title || draft.id,
          payload: toPortableCampaign(draft),
        }),
      });
      const body = (await response.json().catch(() => undefined)) as
        | { error?: { code?: string }; source?: { lastError?: string } }
        | undefined;
      if (!response.ok) {
        throw new Error(
          body?.error?.code
            ? `${response.status} (${body.error.code})`
            : `${response.status}`,
        );
      }
      if (body?.source?.lastError) {
        setOutcome({
          tone: "error",
          text: `Saved, but it failed to load: ${body.source.lastError}. Fix it on My content, or delete that row and submit again.`,
        });
        return;
      }
      setOutcome({
        tone: "ok",
        text: "Submitted. It is playable by you right now, privately, and it is already in the review queue — it becomes public if an admin approves it.",
      });
      onSubmitted();
    } catch (error) {
      setOutcome({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gs-form">
      <p className="gs-prose">
        Submitting sends the campaign exactly as the playtest ran it. It is
        playable by you immediately and privately, and queued for review; nobody
        else sees it unless an admin approves it. Everything you submit stays
        listed on <a href="/content">My content</a>.
      </p>

      {!apiUrl && (
        <p className="gs-note">
          This build has no server configured, so there is nowhere to submit.
          You can still author and playtest — copy the JSON below when you have
          somewhere to send it.
        </p>
      )}
      {apiUrl && loading && <p className="gs-note">Checking your record…</p>}
      {apiUrl && !loading && !signedIn && (
        <p className="gs-note">Sign in first — a submission needs an owner.</p>
      )}
      {!valid && (
        <p className="gs-note">
          The campaign has to validate before it can be submitted.
        </p>
      )}

      <button
        type="button"
        className="gs-btn gs-btn-primary"
        disabled={!apiUrl || !signedIn || !valid || busy}
        onClick={() => void submit()}
      >
        {busy ? "SUBMITTING…" : "SUBMIT ▸"}
      </button>

      {outcome && (
        <p
          className={outcome.tone === "error" ? "gs-error" : "gs-note"}
          role={outcome.tone === "error" ? "alert" : "status"}
        >
          {outcome.text}
        </p>
      )}

      <details className="gs-json">
        <summary>The campaign file this produces</summary>
        <pre>{JSON.stringify(toPortableCampaign(draft), null, 2)}</pre>
      </details>
    </div>
  );
}
