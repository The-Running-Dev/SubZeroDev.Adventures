/**
 * Draft validation -- the engine's own validator, run against an in-progress draft.
 *
 * There is no validator in this file. `hydrateCatalog` (`shared/campaign-registry.ts`) is
 * the same call `createLocalBrowserDemo` makes to build the shipped catalog and the same one
 * `buildTieredCatalog` makes when the server decides whether a submission publishes, and it
 * runs `mergeExtensions` -> `fromPortable` -> `buildValidatedContentRegistry`. Routing the
 * wizard through it is the whole point: a draft that passes here passes for the same reasons,
 * and fails for the same reasons, as it will when `/api/content` loads it.
 *
 * Worth stating plainly, because the names suggest otherwise: `fromPortable` performs no
 * validation of its own (see its header -- it is a rehydrator), and `digestPortableCampaign`
 * is a sha-256 over canonical JSON, so it answers "did this change?" and never "is this
 * correct?". `buildValidatedContentRegistry`, reached through `hydrateCatalog`, is the thing
 * that actually validates, and the digest is used here only to avoid re-running it on a draft
 * that has not changed.
 *
 * ## Why steps do not gate on this
 *
 * A story graph is invalid for almost all of its authoring life -- the first choice points at
 * a node that does not exist yet, and will keep doing so until the author writes it. Blocking
 * "next" on engine validity would make the wizard unusable, and classifying which errors are
 * "expected at this step" would mean parsing error codes into a second model of what a
 * campaign means, which is the duplicated validator this design exists to avoid. So
 * validation runs continuously and is *shown* continuously; only the two operations that
 * genuinely cannot proceed without a valid campaign -- playtest and submit -- are gated on it.
 */
import { useMemo } from "react";
import type {
  ValidationError,
  ValidationWarning,
} from "@the-running-dev/game-engine";
import { hydrateCatalog } from "../../shared/campaign-registry";
import { toPortableCampaign, type CampaignDraft } from "./draft";

export interface DraftValidation {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
  /** Set when the failure was thrown rather than reported -- `mergeExtensions` throwing, or
   *  content malformed enough that `fromPortable` could not walk it. Rare, and not
   *  attributable to a `path`, so it is surfaced as its own line rather than as an error row. */
  readonly fatal?: string;
}

export function validateDraft(draft: CampaignDraft): DraftValidation {
  let result;
  try {
    result = hydrateCatalog([toPortableCampaign(draft)], []);
  } catch (error) {
    return {
      ok: false,
      errors: [],
      warnings: [],
      fatal: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.ok) return { ok: true, errors: [], warnings: result.warnings };
  return {
    ok: false,
    errors: result.errors ?? [],
    warnings: result.warnings ?? [],
    ...(result.errors === undefined ? { fatal: result.error } : {}),
  };
}

/** Re-validates only when the draft's projected content actually changes -- a keystroke in a
 *  field that does not reach the wire document (or an edit that reverts one) costs nothing. */
export function useDraftValidation(draft: CampaignDraft): DraftValidation {
  return useMemo(() => validateDraft(draft), [draft]);
}

/**
 * A validation finding as a sentence.
 *
 * The engine reports `{code, messageKey, path}` and leaves rendering to the host -- the
 * `messageKey`s resolve against a *session's* string table, which a draft that has never
 * started a session does not have. So this maps the codes an author can actually cause to
 * plain English, and falls back to the raw code for anything else rather than pretending to
 * recognise it.
 */
export function describeFinding(
  finding: ValidationError | ValidationWarning,
): string {
  const where = finding.path ? ` (${finding.path})` : "";
  switch (finding.code) {
    case "invalid_identifier":
      return `Campaign id must be lower-case words joined by hyphens${where}.`;
    case "invalid_loc_key":
      // Every key the wizard emits is `<campaign id>.<segments>` (`keyFor`, draft.ts), so a
      // key whose first segment is empty has exactly one cause: the campaign has no id yet.
      // Reporting that as a malformed text key sends an author looking for a key they never
      // wrote and cannot find -- the id field is nowhere near the words "text key". This is
      // the second of the two findings an unnamed draft always produces, alongside
      // `invalid_identifier`, and naming the campaign clears both.
      return finding.path?.startsWith(".")
        ? `Name the campaign — until it has an id, the text keys it defines have nothing to prefix them${where}.`
        : `Malformed text key${where}.`;
    case "missing_string_key":
      return `Some text is still blank${where}.`;
    case "dangling_reference":
      return `A choice leads to a scene that does not exist${where}.`;
    case "duplicate_id":
      return `Two things share the id${where}.`;
    case "missing_label_key":
      return `A visible stat needs a label${where}.`;
    case "non_visible_variable_in_text":
      return `Scene text uses a stat that is not marked visible${where}.`;
    case "undeclared_variable":
      return `An effect writes to a stat that is not declared${where}.`;
    case "invalid_consequence_value":
      return `An effect's value does not match its stat's type${where}.`;
    case "unreachable_node":
      return `Nothing leads to this scene${where}.`;
    case "no_reachable_choice":
      return `No scene with choices can be reached from the opening${where}.`;
    case "no_reachable_ending":
      return `No ending can be reached from the opening${where}.`;
    case "unreachable_cycle":
      return `This scene loops with no way out${where}.`;
    default:
      return `${finding.code}${where}`;
  }
}
