/**
 * The sample is content, and content rots. These specs are what stops it: it is hand-written
 * inside `draft.ts`'s authorable subset rather than imported from `public/campaigns/`, so
 * nothing else in the repository would notice if it drifted out of that subset or stopped
 * validating. They run the same `validateDraft` -- and therefore the same engine validator --
 * that decides whether a submission publishes, so a submodule bump that changed the rules
 * fails here rather than handing an author a broken starting point.
 */
import { describe, expect, it } from "vitest";
import { validateDraft } from "./draft-validation";
import {
  isContentId,
  isKebabCase,
  toPortableCampaign,
  type CampaignDraft,
} from "./draft";
import { sampleDraft } from "./sample";

/** The sample as an author has it the moment they have named it -- which is the only thing
 *  they have to do before it runs. */
function namedSample(): CampaignDraft {
  return { ...sampleDraft(), id: "the-last-tram", title: "The Last Tram" };
}

describe("sampleDraft", () => {
  it("is unnamed, and nothing else is left for the author to fill in", () => {
    const sample = sampleDraft();
    expect(sample.id).toBe("");
    expect(sample.title).toBe("");
    expect(sample.description).not.toBe("");
    expect(sample.version).not.toBe("");
    for (const node of sample.nodes) {
      expect(node.text).not.toBe("");
      for (const choice of node.choices) expect(choice.label).not.toBe("");
    }
  });

  it("is a fresh object each call, so editing one draft cannot alter the next", () => {
    expect(sampleDraft()).not.toBe(sampleDraft());
    expect(sampleDraft()).toEqual(sampleDraft());
  });

  it("stays inside the subset this wizard can actually edit", () => {
    // The point of hand-writing the sample rather than importing fixture content: a sample
    // holding a node kind the wizard does not author would open on a form that silently
    // dropped it. `draft.ts`'s header states that scope line; this asserts it.
    const sample = sampleDraft();
    for (const node of sample.nodes) {
      expect(["choice", "ending"]).toContain(node.kind);
      expect(isContentId(node.id)).toBe(true);
      for (const choice of node.choices)
        expect(isContentId(choice.id)).toBe(true);
    }
    for (const variable of sample.variables)
      expect(isContentId(variable.name)).toBe(true);
    for (const achievement of sample.achievements)
      expect(isContentId(achievement.id)).toBe(true);
  });

  it("reaches both endings, and rewards one of them", () => {
    const sample = sampleDraft();
    const endings = sample.nodes.filter((node) => node.kind === "ending");
    expect(endings.map((node) => node.outcome).sort()).toEqual(["loss", "win"]);
    expect(sample.achievements[0]?.endingId).toBe(
      endings.find((node) => node.outcome === "win")?.endingId,
    );
  });
});

describe("sampleDraft — projection", () => {
  it("projects to a story-graph document with every string key namespaced", () => {
    const portable = toPortableCampaign(namedSample());
    expect(portable.formatVersion).toBe(2);
    expect(portable.campaign.kindId).toBe("story-graph");
    expect(isKebabCase(portable.campaign.id)).toBe(true);
    const keys = Object.keys(portable.strings);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.startsWith("the-last-tram.")).toBe(true);
    // No blank text anywhere -- a string table entry that is empty is a scene an author would
    // have had to write before the sample was worth loading.
    for (const value of Object.values(portable.strings))
      expect(value).not.toBe("");
  });

  it("keeps the opening scene and every choice target inside the graph", () => {
    const content = toPortableCampaign(namedSample()).campaign
      .content as unknown as {
      startNodeId: string;
      nodes: Record<string, { choices?: readonly { goto: string }[] }>;
    };
    expect(content.nodes[content.startNodeId]).toBeDefined();
    for (const node of Object.values(content.nodes))
      for (const choice of node.choices ?? [])
        expect(Object.keys(content.nodes)).toContain(choice.goto);
  });
});

describe("sampleDraft — validation", () => {
  it("validates clean once it is named — no errors, no warnings", () => {
    const result = validateDraft(namedSample());
    expect(result.fatal).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails as shipped on the name alone, which is the existing gate and not a new one", () => {
    // Loading the sample lands the author on the playtest step, where this is what they see.
    // Both findings are about the blank id: `keyFor` prefixes every key with it, so the title
    // key is `.campaign.title` until it is set. Naming the campaign clears both at once, and
    // no code in the wizard checks for this case specially.
    const result = validateDraft(sampleDraft());
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code).sort()).toEqual([
      "invalid_identifier",
      "invalid_loc_key",
    ]);
  });
});
