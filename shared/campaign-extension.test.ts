/**
 * `mergeExtensions` (issue #27): the add-only precedence rules in isolation, plus one
 * end-to-end proof that a merged choice is genuinely *selectable* -- `story-graph/advance.ts`
 * resolves a submitted action by scanning `node.choices`, so if the merge landed anywhere
 * other than content, `engine.submitAction` would reject it as `unknown_action` even though
 * it rendered fine. That is exactly the scene-decoration failure mode this design rejected
 * (issue #27, "Why the merge has to happen at content level").
 *
 * The fixture below is synthetic rather than a real committed campaign, deliberately: this
 * file lives in `shared/`, which CLAUDE.md's Structure table declares "environment-neutral,
 * no DOM, no Node" -- reading a fixture off disk would need `node:fs`, which is exactly the
 * kind of import the browser-portability gate (`scripts/verify-build.mjs`) exists to catch
 * if it ever leaked into shipped code. A minimal in-code campaign keeps this file honest to
 * that rule rather than making it an exception.
 */
import { describe, expect, it } from "vitest";
import {
  createEngine,
  type PortableCampaign,
} from "@the-running-dev/game-engine";
import {
  mergeExtensions,
  type PortableExtension,
} from "./campaign-extension.js";
import { buildCatalog, KINDS } from "./campaign-registry.js";

function fixture(): PortableCampaign {
  return {
    formatVersion: 2,
    catalog: {
      title: "Test Campaign",
      description: "A minimal story-graph campaign for merge tests.",
      duration: "5 min",
      contentNotice: "none",
      featured: false,
    },
    campaign: {
      id: "test-campaign",
      kindId: "story-graph",
      version: "1.0.0",
      titleKey: "test.title",
      content: {
        descriptionKey: "test.description",
        variables: {},
        nodes: {
          start: {
            id: "start",
            kind: "choice",
            textKey: "test.start.text",
            choices: [{ id: "go", labelKey: "test.start.go", goto: "end" }],
          },
          end: {
            id: "end",
            kind: "ending",
            textKey: "test.end.text",
            endingId: "end",
          },
        },
        startNodeId: "start",
        achievements: [
          {
            id: "existing_achievement",
            nameKey: "test.ach.name",
            descriptionKey: "test.ach.desc",
            condition: { all: [] },
            hidden: false,
          },
        ],
      },
    },
    strings: {
      "test.title": "Test Campaign",
      "test.description": "A minimal story-graph campaign for merge tests.",
      "test.start.text": "You are at the start.",
      "test.start.go": "Go to the end",
      "test.end.text": "The end.",
      "test.ach.name": "Achievement",
      "test.ach.desc": "You did it.",
    },
  };
}

function baseExtension(
  overrides: Partial<PortableExtension> = {},
): PortableExtension {
  return {
    formatVersion: 1,
    id: "test-extension",
    extends: "test-campaign",
    ...overrides,
  };
}

describe("mergeExtensions", () => {
  it("returns the input unchanged when there are no extensions", () => {
    const portables = [fixture()];
    expect(mergeExtensions(portables, [])).toBe(portables);
  });

  it("adds a new node, a new choice on an existing node, and merges strings", () => {
    const portables = [fixture()];
    const merged = mergeExtensions(portables, [
      baseExtension({
        nodes: {
          side_quest: {
            id: "side_quest",
            kind: "ending",
            textKey: "test.side_quest.text",
            endingId: "side_quest",
          },
        },
        addChoices: [
          {
            nodeId: "start",
            choice: {
              id: "take_side_quest",
              labelKey: "test.side_quest.label",
              goto: "side_quest",
            },
          },
        ],
        strings: {
          "test.side_quest.text": "A side quest.",
          "test.side_quest.label": "Take the side quest",
        },
      }),
    ]);

    const content = merged[0]!.campaign.content as {
      nodes: Record<string, { choices?: { id: string }[] }>;
    };
    expect(content.nodes.side_quest).toBeDefined();
    expect(
      content.nodes.start!.choices!.some((c) => c.id === "take_side_quest"),
    ).toBe(true);
    expect(merged[0]!.strings["test.side_quest.text"]).toBe("A side quest.");

    // The original input is untouched -- `mergeExtensions` clones before mutating.
    const original = portables[0]!.campaign.content as {
      nodes: Record<string, unknown>;
    };
    expect(original.nodes.side_quest).toBeUndefined();
  });

  it("fails the whole merge when an extension targets an unknown campaign", () => {
    const portables = [fixture()];
    expect(() =>
      mergeExtensions(portables, [
        baseExtension({ extends: "no-such-campaign" }),
      ]),
    ).toThrow(/unknown campaign/);
  });

  it("fails rather than silently overwriting a node id that already exists", () => {
    const portables = [fixture()];
    expect(() =>
      mergeExtensions(portables, [
        baseExtension({ nodes: { start: { id: "start", kind: "auto" } } }),
      ]),
    ).toThrow(/already exists/);
  });

  it("fails when the target node for addChoices does not exist", () => {
    const portables = [fixture()];
    expect(() =>
      mergeExtensions(portables, [
        baseExtension({
          addChoices: [
            {
              nodeId: "no-such-node",
              choice: { id: "x", labelKey: "k", goto: "start" },
            },
          ],
        }),
      ]),
    ).toThrow(/does not exist/);
  });

  it("fails when the target node for addChoices is not a choice node", () => {
    const portables = [fixture()];
    expect(() =>
      mergeExtensions(portables, [
        baseExtension({
          addChoices: [
            {
              nodeId: "end",
              choice: { id: "x", labelKey: "k", goto: "start" },
            },
          ],
        }),
      ]),
    ).toThrow(/not a choice node/);
  });

  it("fails rather than silently overwriting a choice id that already exists on the target node", () => {
    const portables = [fixture()];
    expect(() =>
      mergeExtensions(portables, [
        baseExtension({
          addChoices: [
            {
              nodeId: "start",
              choice: { id: "go", labelKey: "k", goto: "start" },
            },
          ],
        }),
      ]),
    ).toThrow(/already exists/);
  });

  it("fails rather than silently overwriting a duplicate achievement id", () => {
    const portables = [fixture()];
    expect(() =>
      mergeExtensions(portables, [
        baseExtension({
          achievements: [
            {
              id: "existing_achievement",
              nameKey: "k",
              descriptionKey: "k",
            },
          ],
        }),
      ]),
    ).toThrow(/already exists/);
  });

  it("applies extensions in manifest order, and later strings win on the same key", () => {
    const portables = [fixture()];
    const merged = mergeExtensions(portables, [
      baseExtension({ id: "first", strings: { "test.k": "first" } }),
      baseExtension({ id: "second", strings: { "test.k": "second" } }),
    ]);
    expect(merged[0]!.strings["test.k"]).toBe("second");
  });
});

describe("an extension's added choice is selectable, not merely rendered", () => {
  it("submitAction succeeds on a choice that only an extension added", () => {
    const portables = [fixture()];
    const extension = baseExtension({
      nodes: {
        side_quest_ending: {
          id: "side_quest_ending",
          kind: "ending",
          textKey: "test.side_quest.text",
          endingId: "side_quest_ending",
        },
      },
      addChoices: [
        {
          nodeId: "start",
          choice: {
            id: "take_side_quest",
            labelKey: "test.side_quest.label",
            goto: "side_quest_ending",
          },
        },
      ],
      strings: {
        "test.side_quest.text": "You take the extension's side quest.",
        "test.side_quest.label": "Take the side quest",
      },
    });

    const { registry } = buildCatalog(portables, [extension]);
    const engine = createEngine({ kinds: KINDS, registry });

    const created = engine.createGame({ campaignId: "test-campaign" });
    expect(created.ok).toBe(true);
    const started = created.value!;
    expect((started.kindState as { currentNodeId: string }).currentNodeId).toBe(
      "start",
    );

    // The proof: `submitAction` resolves the choice through `content.nodes[].choices`
    // (advance.ts), the exact path a scene-only decoration would fail at.
    const result = engine.submitAction(started, "take_side_quest");
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);

    const scene = engine.scene(result.value!);
    expect(scene.status).toBe("ended");
  });
});
