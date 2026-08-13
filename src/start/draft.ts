/**
 * The authoring wizard's own draft model, and its projection to a `PortableCampaign`.
 *
 * Two shapes, deliberately not one. A `PortableCampaign` is the wire format: string tables
 * separated from the content that references them, ids repeated as `Record` keys, `LocKey`s
 * everywhere a person would rather see a sentence. That is right for a file and wrong for a
 * form. `CampaignDraft` is what the form edits -- text inline, one flat list per concept,
 * every numeric field still a string because a half-typed `-` is a legal thing for an input
 * to hold -- and `toPortableCampaign` is the one place the two meet.
 *
 * The draft is browser-local (see `loadDraft`/`saveDraft` below). Nothing here talks to the
 * server: a finished draft leaves through `/api/content`'s existing `"pasted"` submission,
 * as one `PortableCampaign` payload, exactly as if the author had pasted the JSON by hand
 * on `/content`.
 *
 * ## What is deliberately not authorable here
 *
 * The story-graph kind has four node kinds, conditional choices, and an arbitrary
 * `Condition` tree (`engine/src/engine/src/kinds/story-graph/`). This wizard exposes choice
 * nodes, ending nodes, typed variables, choice effects, and ending-triggered achievements --
 * the subset that composes into a complete, playable campaign without a graph editor. The
 * rest (`random`/`auto` nodes, `showWhen`/`requirements`, nested conditions) stays reachable
 * the way it already is: paste the JSON on `/content`. That is a scope line, not a
 * limitation of the format, and `toPortableCampaign` emits nothing that would collide with
 * those fields if a later revision adds them.
 */
import {
  digestPortableCampaign,
  type PortableCampaign,
} from "@the-running-dev/game-engine";

export type DraftVariableType = "bool" | "int" | "enum";

/** `set` writes a literal; `increment`/`decrement` are int-only, matching `Consequence`. */
export type DraftEffectOp = "set" | "increment" | "decrement";

export interface DraftEffect {
  readonly variable: string;
  readonly op: DraftEffectOp;
  /** Raw input text, coerced against the target variable's declared type on projection. */
  readonly value: string;
}

export interface DraftChoice {
  readonly id: string;
  readonly label: string;
  /** The node id this choice leads to. Empty until the author picks one. */
  readonly goto: string;
  readonly effects: readonly DraftEffect[];
}

export interface DraftNode {
  readonly id: string;
  readonly kind: "choice" | "ending";
  readonly text: string;
  /** `kind: "choice"` only. */
  readonly choices: readonly DraftChoice[];
  /** `kind: "ending"` only -- the terminal id achievements and the shelf's ending count key off. */
  readonly endingId: string;
  readonly outcome: "win" | "loss" | "neutral";
}

export interface DraftVariable {
  readonly name: string;
  readonly type: DraftVariableType;
  /** Raw input text; coerced by `type` on projection. */
  readonly initial: string;
  /** `type: "enum"` only -- comma-separated members. */
  readonly values: string;
  /** `type: "int"` only. Empty means unbounded in that direction. */
  readonly min: string;
  readonly max: string;
  /** A visible variable is shown to the player as a stat, and is the only kind a node's text
   *  may interpolate (`validateTextInterpolation`, story-graph/validate.ts). */
  readonly visible: boolean;
  readonly label: string;
}

export interface DraftAchievement {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly hidden: boolean;
  /** Unlocks on reaching this ending id -- the one condition shape the wizard authors. */
  readonly endingId: string;
}

export interface CampaignDraft {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly duration: string;
  readonly contentNotice: string;
  readonly version: string;
  readonly startNodeId: string;
  readonly variables: readonly DraftVariable[];
  readonly nodes: readonly DraftNode[];
  readonly achievements: readonly DraftAchievement[];
}

export function emptyDraft(): CampaignDraft {
  return {
    id: "",
    title: "",
    description: "",
    duration: "~5 min",
    contentNotice: "",
    version: "1.0.0",
    startNodeId: "start",
    variables: [],
    nodes: [
      {
        id: "start",
        kind: "choice",
        text: "",
        choices: [{ id: "begin", label: "", goto: "", effects: [] }],
        endingId: "",
        outcome: "neutral",
      },
    ],
    achievements: [],
  };
}

export function emptyNode(id: string, kind: DraftNode["kind"]): DraftNode {
  return {
    id,
    kind,
    text: "",
    choices:
      kind === "choice"
        ? [{ id: "next", label: "", goto: "", effects: [] }]
        : [],
    endingId: kind === "ending" ? id : "",
    outcome: "neutral",
  };
}

export function emptyVariable(name: string): DraftVariable {
  return {
    name,
    type: "int",
    initial: "0",
    values: "",
    min: "",
    max: "",
    visible: false,
    label: "",
  };
}

export function emptyAchievement(id: string): DraftAchievement {
  return { id, name: "", description: "", hidden: false, endingId: "" };
}

// ---------------------------------------------------------------------------
// Identifiers and string keys
// ---------------------------------------------------------------------------

/** `04-core.md` §17, enforced by `validateCoreOwnedFields`: campaign ids are kebab-case. */
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isKebabCase(value: string): boolean {
  return KEBAB_CASE.test(value);
}

/** Node, choice, variable, ending, and achievement ids are content-internal -- the engine
 *  imposes no shape on them, but they end up inside dotted `LocKey`s, so anything outside
 *  `[a-z0-9_]` is rejected here rather than producing a key that reads as two segments. */
const CONTENT_ID = /^[a-z][a-z0-9_]*$/;

export function isContentId(value: string): boolean {
  return CONTENT_ID.test(value);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Every string this campaign contributes is prefixed with the campaign's own id.
 *
 * Not cosmetic. `registry.strings` is one flat table merged across every registered
 * campaign, and `buildTieredCatalog` quarantines a submission whose unnamespaced key
 * collides with content that is already published (`shared/campaign-registry.ts`). An
 * author who names a key `intro.text` is one coincidence away from having their whole
 * submission dropped for a reason they cannot see; prefixing removes that class of failure
 * before it can happen.
 */
function keyFor(draft: CampaignDraft, ...segments: string[]): string {
  return [draft.id, ...segments].join(".");
}

// ---------------------------------------------------------------------------
// Projection to the wire format
// ---------------------------------------------------------------------------

function coerceValue(
  raw: string,
  type: DraftVariableType,
): boolean | number | string {
  if (type === "bool") return raw.trim() === "true";
  if (type === "int") {
    const parsed = Number(raw.trim());
    // A non-numeric or fractional entry is passed through as `NaN` rather than silently
    // becoming 0: the engine's own `checkSetValue` rejects it, which is the error the
    // author needs to see, and inventing a plausible number here would hide it.
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return raw;
}

function enumMembers(variable: DraftVariable): string[] {
  return variable.values
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
}

function variableTypeOf(
  draft: CampaignDraft,
  name: string,
): DraftVariableType | undefined {
  return draft.variables.find((variable) => variable.name === name)?.type;
}

function effectsOf(
  draft: CampaignDraft,
  effects: readonly DraftEffect[],
): readonly unknown[] | undefined {
  if (effects.length === 0) return undefined;
  return effects.map((effect) => {
    if (effect.op === "set") {
      return {
        op: "set",
        var: effect.variable,
        value: coerceValue(
          effect.value,
          variableTypeOf(draft, effect.variable) ?? "int",
        ),
      };
    }
    const by = Number(effect.value.trim());
    return {
      op: effect.op,
      var: effect.variable,
      by: Number.isFinite(by) ? by : Number.NaN,
    };
  });
}

function nodeToContent(draft: CampaignDraft, node: DraftNode): unknown {
  if (node.kind === "ending") {
    return {
      id: node.id,
      kind: "ending",
      textKey: keyFor(draft, `node_${node.id}`, "text"),
      endingId: node.endingId,
      outcome: node.outcome,
    };
  }
  return {
    id: node.id,
    kind: "choice",
    textKey: keyFor(draft, `node_${node.id}`, "text"),
    choices: node.choices.map((choice) => {
      const effects = effectsOf(draft, choice.effects);
      return {
        id: choice.id,
        labelKey: keyFor(draft, `choice_${node.id}_${choice.id}`, "label"),
        goto: choice.goto,
        ...(effects ? { effects } : {}),
      };
    }),
  };
}

function variableToContent(variable: DraftVariable): unknown {
  const min = variable.min.trim();
  const max = variable.max.trim();
  return {
    type: variable.type,
    initial: coerceValue(variable.initial, variable.type),
    ...(variable.type === "enum" ? { values: enumMembers(variable) } : {}),
    ...(variable.type === "int" && min !== "" ? { min: Number(min) } : {}),
    ...(variable.type === "int" && max !== "" ? { max: Number(max) } : {}),
    ...(variable.visible ? { visible: true } : {}),
  };
}

function stringsOf(draft: CampaignDraft): Record<string, string> {
  const strings: Record<string, string> = {
    [keyFor(draft, "campaign", "title")]: draft.title,
    [keyFor(draft, "campaign", "description")]: draft.description,
  };
  for (const node of draft.nodes) {
    strings[keyFor(draft, `node_${node.id}`, "text")] = node.text;
    for (const choice of node.choices) {
      strings[keyFor(draft, `choice_${node.id}_${choice.id}`, "label")] =
        choice.label;
    }
  }
  for (const variable of draft.variables) {
    if (variable.visible) {
      strings[keyFor(draft, `var_${variable.name}`, "label")] = variable.label;
    }
  }
  for (const achievement of draft.achievements) {
    strings[keyFor(draft, `ach_${achievement.id}`, "name")] = achievement.name;
    strings[keyFor(draft, `ach_${achievement.id}`, "description")] =
      achievement.description;
  }
  // Sorted for the same reason `toPortable` sorts its own table: the payload is digested,
  // so an insertion-order difference must not read as a content change.
  return Object.fromEntries(
    Object.entries(strings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * The draft as the wire document the server, the validator, and the playtest runtime all
 * read. Total, and deliberately unvalidating: an incomplete draft still projects, producing
 * a document the engine's own validator then rejects with a locatable `path`. Anything that
 * refused to project here would be a second validator, disagreeing with the first.
 */
export function toPortableCampaign(draft: CampaignDraft): PortableCampaign {
  const variables: Record<string, unknown> = {};
  for (const variable of draft.variables) {
    variables[variable.name] = {
      ...(variableToContent(variable) as Record<string, unknown>),
      ...(variable.visible
        ? { labelKey: keyFor(draft, `var_${variable.name}`, "label") }
        : {}),
    };
  }

  const nodes: Record<string, unknown> = {};
  for (const node of draft.nodes) nodes[node.id] = nodeToContent(draft, node);

  return {
    formatVersion: 2,
    catalog: {
      title: draft.title,
      description: draft.description,
      duration: draft.duration,
      contentNotice: draft.contentNotice,
      featured: false,
    },
    campaign: {
      id: draft.id,
      kindId: "story-graph",
      version: draft.version,
      titleKey: keyFor(draft, "campaign", "title"),
      content: {
        descriptionKey: keyFor(draft, "campaign", "description"),
        startNodeId: draft.startNodeId,
        variables,
        nodes,
        achievements: draft.achievements.map((achievement) => ({
          id: achievement.id,
          nameKey: keyFor(draft, `ach_${achievement.id}`, "name"),
          descriptionKey: keyFor(draft, `ach_${achievement.id}`, "description"),
          hidden: achievement.hidden,
          condition: {
            field: "ending",
            operator: "equals",
            value: achievement.endingId,
          },
        })),
      },
    } as PortableCampaign["campaign"],
    strings: stringsOf(draft),
  };
}

/** Content identity for a draft -- the engine's own digest over the projected document. Used
 *  to decide when the playtest runtime has to be rebuilt and when a validation result is
 *  still current, rather than re-running either on every keystroke. */
export function draftDigest(draft: CampaignDraft): string {
  return digestPortableCampaign(toPortableCampaign(draft));
}

// ---------------------------------------------------------------------------
// Browser-local persistence
// ---------------------------------------------------------------------------

const DRAFT_KEY = "subzerodev.play.draft.v1";

/**
 * One draft, in this browser, until it is submitted. There is no server-side draft store --
 * `content_sources` holds submissions, not works in progress, and adding a second thing it
 * holds is a schema decision this feature does not need to make.
 *
 * Guarded exactly as `theme.ts` guards its own reads: storage can be absent or throw
 * (private browsing, full quota), and losing a draft is better than a page that will not
 * render.
 */
export function loadDraft(): CampaignDraft | undefined {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<CampaignDraft>;
    // Shape-checked rather than trusted: this is the author's own storage, but a key from an
    // older revision of this wizard would otherwise crash the form on mount.
    if (!Array.isArray(parsed.nodes) || typeof parsed.id !== "string")
      return undefined;
    return { ...emptyDraft(), ...parsed };
  } catch {
    return undefined;
  }
}

export function saveDraft(draft: CampaignDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Best-effort, same posture as `storeTheme`: the draft still edits for this page view.
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to fall back to.
  }
}
