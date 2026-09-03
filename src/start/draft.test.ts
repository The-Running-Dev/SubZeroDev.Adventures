import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDraft,
  draftDigest,
  emptyDraft,
  isContentId,
  isKebabCase,
  loadDraft,
  saveDraft,
  slugify,
  toPortableCampaign,
  type CampaignDraft,
} from "./draft";

/** A complete, valid two-scene campaign -- the smallest thing that plays end to end. */
export function completeDraft(): CampaignDraft {
  return {
    ...emptyDraft(),
    id: "test-campaign",
    title: "Test Campaign",
    description: "A campaign for tests.",
    startNodeId: "start",
    variables: [
      {
        name: "nerve",
        type: "int",
        initial: "2",
        values: "",
        min: "0",
        max: "5",
        visible: true,
        label: "Nerve",
      },
    ],
    nodes: [
      {
        id: "start",
        kind: "choice",
        text: "You are at the start.",
        choices: [
          {
            id: "go",
            label: "Go on.",
            goto: "finish",
            effects: [{ variable: "nerve", op: "increment", value: "1" }],
          },
        ],
        endingId: "",
        outcome: "neutral",
      },
      {
        id: "finish",
        kind: "ending",
        text: "It is over.",
        choices: [],
        endingId: "done",
        outcome: "win",
      },
    ],
    achievements: [
      {
        id: "finished",
        name: "Finished",
        description: "Reached the end.",
        hidden: false,
        endingId: "done",
      },
    ],
  };
}

describe("identifiers", () => {
  it("accepts kebab-case campaign ids and rejects everything else", () => {
    expect(isKebabCase("test-campaign")).toBe(true);
    expect(isKebabCase("a1")).toBe(true);
    expect(isKebabCase("Test-Campaign")).toBe(false);
    expect(isKebabCase("test_campaign")).toBe(false);
    expect(isKebabCase("-leading")).toBe(false);
  });

  it("accepts underscore content ids and rejects dotted ones", () => {
    expect(isContentId("start")).toBe(true);
    expect(isContentId("scene_2")).toBe(true);
    // A dot would split the key into an extra segment, which is the whole reason this exists.
    expect(isContentId("scene.2")).toBe(false);
    expect(isContentId("2scene")).toBe(false);
  });

  it("slugifies a title into a usable campaign id", () => {
    expect(slugify("The Bureaucracy: Part Two!")).toBe(
      "the-bureaucracy-part-two",
    );
  });
});

describe("toPortableCampaign", () => {
  it("namespaces every string key with the campaign id", () => {
    const portable = toPortableCampaign(completeDraft());
    const keys = Object.keys(portable.strings);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.startsWith("test-campaign.")).toBe(true);
  });

  it("emits a story-graph document the wire format recognises", () => {
    const portable = toPortableCampaign(completeDraft());
    expect(portable.formatVersion).toBe(2);
    expect(portable.campaign.kindId).toBe("story-graph");
    expect(portable.campaign.titleKey).toBe("test-campaign.campaign.title");
    expect(portable.catalog.featured).toBe(false);
    // `classifyPastedPayload` (server/src/campaigns/multi-source.ts) decides a pasted
    // submission is a campaign on exactly these two keys being present.
    expect(portable).toHaveProperty("campaign");
    expect(portable).toHaveProperty("catalog");
  });

  it("carries a visible variable's bounds and label key through", () => {
    // `campaign.content` is a kind-discriminated union on the wire; these specs are about the
    // story-graph arm specifically, so the narrowing goes through `unknown`.
    const content = toPortableCampaign(completeDraft()).campaign
      .content as unknown as {
      variables: Record<string, Record<string, unknown>>;
    };
    expect(content.variables.nerve).toMatchObject({
      type: "int",
      initial: 2,
      min: 0,
      max: 5,
      visible: true,
      labelKey: "test-campaign.var_nerve.label",
    });
  });

  it("omits an empty effects array rather than emitting one", () => {
    const draft = completeDraft();
    const withoutEffects: CampaignDraft = {
      ...draft,
      nodes: draft.nodes.map((node) =>
        node.id === "start"
          ? {
              ...node,
              choices: node.choices.map((choice) => ({
                ...choice,
                effects: [],
              })),
            }
          : node,
      ),
    };
    const content = toPortableCampaign(withoutEffects).campaign
      .content as unknown as {
      nodes: Record<string, Record<string, unknown>>;
    };
    expect(content.nodes.start).not.toHaveProperty("effects");
    expect(
      (content.nodes.start!.choices as Record<string, unknown>[])[0],
    ).not.toHaveProperty("effects");
  });

  it("passes a non-numeric int through as NaN instead of inventing a zero", () => {
    const draft = completeDraft();
    const broken: CampaignDraft = {
      ...draft,
      variables: [{ ...draft.variables[0]!, initial: "lots" }],
    };
    const content = toPortableCampaign(broken).campaign.content as unknown as {
      variables: Record<string, { initial: number }>;
    };
    expect(Number.isNaN(content.variables.nerve!.initial)).toBe(true);
  });
});

describe("draftDigest", () => {
  it("is stable across two projections of the same draft", () => {
    expect(draftDigest(completeDraft())).toBe(draftDigest(completeDraft()));
  });

  it("changes when the content changes", () => {
    const draft = completeDraft();
    const edited: CampaignDraft = { ...draft, title: "Something Else" };
    expect(draftDigest(edited)).not.toBe(draftDigest(draft));
  });

  it("does not change when only the draft's field order changes", () => {
    const draft = completeDraft();
    const reordered: CampaignDraft = {
      achievements: draft.achievements,
      nodes: draft.nodes,
      variables: draft.variables,
      startNodeId: draft.startNodeId,
      version: draft.version,
      contentNotice: draft.contentNotice,
      duration: draft.duration,
      description: draft.description,
      title: draft.title,
      id: draft.id,
    };
    expect(draftDigest(reordered)).toBe(draftDigest(draft));
  });
});

describe("browser-local persistence", () => {
  beforeEach(() => {
    clearDraft();
  });

  it("round-trips a draft", () => {
    const draft = completeDraft();
    saveDraft(draft);
    expect(loadDraft()).toEqual(draft);
  });

  it("returns undefined when nothing is stored", () => {
    expect(loadDraft()).toBeUndefined();
  });

  it("discards a stored value of the wrong shape instead of crashing", () => {
    localStorage.setItem("subzerodev.play.draft.v1", '{"id":"x"}');
    expect(loadDraft()).toBeUndefined();
    localStorage.setItem("subzerodev.play.draft.v1", "not json");
    expect(loadDraft()).toBeUndefined();
  });
});
