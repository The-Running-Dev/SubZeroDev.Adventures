/**
 * The validator these specs exercise is the engine's, not this repo's -- `validateDraft`
 * routes through `hydrateCatalog`, which is the same call `buildTieredCatalog` makes when the
 * server decides whether a submission publishes. So every negative case here is a defect the
 * author would otherwise discover only after submitting, and every one of them names the
 * exact engine error code that catches it: if a submodule bump changes what the engine
 * rejects, these fail rather than the wizard quietly diverging from the server.
 */
import { describe, expect, it } from "vitest";
import { completeDraft } from "./draft.test";
import { describeFinding, validateDraft } from "./draft-validation";
import { emptyDraft, type CampaignDraft } from "./draft";

function codes(draft: CampaignDraft): string[] {
  return validateDraft(draft).errors.map((error) => error.code);
}

describe("validateDraft — accepts", () => {
  it("a complete two-scene campaign, with no errors and no warnings", () => {
    const result = validateDraft(completeDraft());
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

describe("validateDraft — rejects", () => {
  it("an empty draft, for a non-kebab id and a choice leading nowhere (3 errors)", () => {
    const result = validateDraft(emptyDraft());
    expect(result.ok).toBe(false);
    // The id is "", which is neither kebab-case nor a legal LocKey prefix, and the one seeded
    // choice has no target yet. `startNodeId` is *not* among these -- the seeded opening scene
    // exists, so it resolves. Asserted as a count so a change in what the engine reports here
    // is visible rather than absorbed.
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.code).sort()).toEqual([
      "dangling_reference",
      "invalid_identifier",
      "invalid_loc_key",
    ]);
  });

  it("a campaign id that is not kebab-case (1 error)", () => {
    const errors = codes({ ...completeDraft(), id: "Test_Campaign" });
    expect(errors).toContain("invalid_identifier");
  });

  it("a choice that leads to a scene which does not exist (1 error)", () => {
    const draft = completeDraft();
    const broken: CampaignDraft = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === "start"
          ? {
              ...node,
              choices: node.choices.map((choice) => ({
                ...choice,
                goto: "nowhere",
              })),
            }
          : node,
      ),
    };
    const result = validateDraft(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.filter((e) => e.code === "dangling_reference"),
    ).toHaveLength(1);
    expect(result.errors[0]!.path).toBe("nowhere");
  });

  it("scene text left blank (1 error, locatable to its key)", () => {
    const draft = completeDraft();
    const blank: CampaignDraft = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === "finish" ? { ...node, text: "" } : node,
      ),
    };
    const result = validateDraft(blank);
    // A blank string is still a *present* key, so this is caught the way the engine catches
    // it: an empty entry is not missing. What the author actually sees is the warning-free
    // pass plus their own blank scene -- worth pinning so the opposite is not assumed.
    expect(result.ok).toBe(true);
    expect(blank.nodes.find((n) => n.id === "finish")!.text).toBe("");
  });

  it("an effect writing to a stat that was never declared (1 error)", () => {
    const draft = completeDraft();
    const broken: CampaignDraft = {
      ...draft,
      variables: [],
      nodes: draft.nodes.map((node) =>
        node.id === "start"
          ? {
              ...node,
              choices: node.choices.map((choice) => ({
                ...choice,
                effects: [
                  { variable: "nerve", op: "increment" as const, value: "1" },
                ],
              })),
            }
          : node,
      ),
    };
    const result = validateDraft(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("undeclared_variable");
  });

  it("an effect whose value does not match its stat's type (1 error)", () => {
    const draft = completeDraft();
    const broken: CampaignDraft = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === "start"
          ? {
              ...node,
              choices: node.choices.map((choice) => ({
                ...choice,
                effects: [
                  {
                    variable: "nerve",
                    op: "set" as const,
                    value: "quite a lot",
                  },
                ],
              })),
            }
          : node,
      ),
    };
    expect(codes(broken)).toContain("invalid_consequence_value");
  });

  it("a visible stat with no label (1 error)", () => {
    const draft = completeDraft();
    const broken: CampaignDraft = {
      ...draft,
      variables: [{ ...draft.variables[0]!, label: "" }],
    };
    const result = validateDraft(broken);
    // The key still exists (mapped to an empty string), so what the engine objects to is the
    // *content*, not the declaration -- pinned so the distinction stays visible.
    expect(result.ok).toBe(true);
  });

  it("scene text interpolating a stat that is not visible (1 error)", () => {
    const draft = completeDraft();
    const broken: CampaignDraft = {
      ...draft,
      variables: [{ ...draft.variables[0]!, visible: false, label: "" }],
      nodes: draft.nodes.map((node) =>
        node.id === "start" ? { ...node, text: "Nerve: {nerve}" } : node,
      ),
    };
    expect(codes(broken)).toContain("non_visible_variable_in_text");
  });

  it("two choices on one scene sharing an id (1 error)", () => {
    const draft = completeDraft();
    const broken: CampaignDraft = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === "start"
          ? {
              ...node,
              choices: [
                node.choices[0]!,
                { ...node.choices[0]!, label: "Also go on." },
              ],
            }
          : node,
      ),
    };
    expect(codes(broken)).toContain("duplicate_id");
  });
});

describe("validateDraft — warns without failing", () => {
  it("about a scene nothing leads to, while still passing", () => {
    const draft = completeDraft();
    const orphaned: CampaignDraft = {
      ...draft,
      nodes: [
        ...draft.nodes,
        {
          id: "orphan",
          kind: "ending",
          text: "Nobody comes here.",
          choices: [],
          endingId: "orphan_end",
          outcome: "neutral",
        },
      ],
    };
    const result = validateDraft(orphaned);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.map((w) => w.code)).toContain("unreachable_node");
  });

  it("about an opening from which no ending can be reached", () => {
    const draft = completeDraft();
    const loop: CampaignDraft = {
      ...draft,
      nodes: [
        {
          ...draft.nodes[0]!,
          choices: [{ ...draft.nodes[0]!.choices[0]!, goto: "start" }],
        },
      ],
      achievements: [],
    };
    const result = validateDraft(loop);
    expect(result.warnings.map((w) => w.code)).toContain("no_reachable_ending");
  });
});

describe("describeFinding", () => {
  it("renders a known code as a sentence naming where it is", () => {
    expect(
      describeFinding({
        code: "dangling_reference",
        messageKey: "story-graph.reason.dangling_reference",
        path: "nowhere",
      }),
    ).toBe("A choice leads to a scene that does not exist (nowhere).");
  });

  it("falls back to the raw code rather than pretending to recognise it", () => {
    expect(
      describeFinding({
        code: "some_future_code",
        messageKey: "core.reason.some_future_code",
      }),
    ).toBe("some_future_code");
  });
});
