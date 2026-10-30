/**
 * The pure half of content epochs (engine plan 54, D2 and §3.2 step 1): the derived version an
 * extended campaign publishes under, and the candidate a refresh builds before anything is
 * committed. The durable half -- publication, hydration, conflict -- is in `epochs.test.ts`,
 * against Postgres.
 */
import { describe, expect, it } from "vitest";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import type { PortableExtension } from "../../../shared/campaign-extension.js";
import { buildCandidate, CoreContentError } from "./candidate.js";
import { deriveVersion, ReservedVersionError } from "./derived-version.js";

function campaign(id: string, version = "1.0.0", endText = "The end.") {
  return {
    formatVersion: 2,
    catalog: {
      title: id,
      description: "d",
      duration: "5 min",
      contentNotice: "none",
      featured: false,
    },
    campaign: {
      id,
      kindId: "story-graph",
      version,
      titleKey: `${id}.title`,
      content: {
        descriptionKey: `${id}.description`,
        variables: {},
        nodes: {
          start: {
            id: "start",
            kind: "choice",
            textKey: `${id}.start.text`,
            choices: [{ id: "go", labelKey: `${id}.start.go`, goto: "end" }],
          },
          end: {
            id: "end",
            kind: "ending",
            textKey: `${id}.end.text`,
            endingId: "end",
          },
        },
        startNodeId: "start",
        achievements: [],
      },
    },
    strings: {
      [`${id}.title`]: id,
      [`${id}.description`]: "d",
      [`${id}.start.text`]: "You are at the start.",
      [`${id}.start.go`]: "Go to the end",
      [`${id}.end.text`]: endText,
    },
  } as unknown as PortableCampaign;
}

function extension(id: string, base: string): PortableExtension {
  return {
    formatVersion: 1,
    id,
    extends: base,
    nodes: {
      [`${id}-aside`]: {
        id: `${id}-aside`,
        kind: "ending",
        textKey: `${id}.aside.text`,
        endingId: `${id}-aside`,
      },
    },
    addChoices: [
      {
        nodeId: "start",
        choice: { id: `${id}-go`, labelKey: `${id}.go`, goto: `${id}-aside` },
      },
    ],
    strings: { [`${id}.aside.text`]: "An aside.", [`${id}.go`]: "Wander off" },
  };
}

const owner = () => ({ ownerPlayerId: "p1", visibility: "public" as const });

describe("deriveVersion", () => {
  it("keeps the authored version when nothing extends the campaign", () => {
    expect(deriveVersion("c", "1.0.0", [])).toEqual({
      version: "1.0.0",
      extensionsDigest: undefined,
    });
  });

  it("names the composition in build metadata, stably", () => {
    const one = deriveVersion("c", "1.0.0", [extension("x", "c")]);
    expect(one.version).toMatch(/^1\.0\.0\+ext\.[0-9a-f]{12}$/);
    expect(one.extensionsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(one.version.endsWith(one.extensionsDigest!.slice(0, 12))).toBe(true);
    expect(deriveVersion("c", "1.0.0", [extension("x", "c")])).toEqual(one);
  });

  it("appends to build metadata the author already wrote", () => {
    expect(
      deriveVersion("c", "1.0.0+build.7", [extension("x", "c")]).version,
    ).toMatch(/^1\.0\.0\+build\.7\.ext\.[0-9a-f]{12}$/);
  });

  it("tells two compositions apart, and depends on application order", () => {
    const a = extension("a", "c");
    const b = extension("b", "c");
    const ab = deriveVersion("c", "1.0.0", [a, b]).version;
    expect(deriveVersion("c", "1.0.0", [a]).version).not.toBe(ab);
    expect(deriveVersion("c", "1.0.0", [b, a]).version).not.toBe(ab);
  });

  it("refuses an authored version that already uses the reserved identifier", () => {
    expect(() => deriveVersion("c", "1.0.0+ext.abc", [])).toThrow(
      ReservedVersionError,
    );
    expect(() => deriveVersion("c", "1.0.0+build.ext", [])).toThrow(
      ReservedVersionError,
    );
    // Only a whole identifier is reserved.
    expect(deriveVersion("c", "1.0.0+extra", []).version).toBe("1.0.0+extra");
  });
});

describe("buildCandidate", () => {
  it("is one epoch per campaign, core with no provenance", () => {
    const built = buildCandidate(
      [campaign("core-a"), campaign("core-b")],
      [],
      [{ sourceId: "s1", portable: campaign("sub") }],
      owner,
    );
    expect(
      built.epochs.map((e) => [e.stored.form.campaign.id, e.provenance]),
    ).toEqual([
      ["core-a", null],
      ["core-b", null],
      ["sub", { ownerPlayerId: "p1", visibility: "public" }],
    ]);
    expect(built.quarantined).toEqual([]);
    expect(built.accepted.map((c) => c.sourceId)).toEqual(["s1"]);
    for (const epoch of built.epochs)
      expect([...epoch.registry.campaigns.keys()]).toEqual([
        epoch.stored.form.campaign.id,
      ]);
  });

  it("publishes an extended campaign under its derived version", () => {
    const built = buildCandidate(
      [campaign("core-a")],
      [extension("x", "core-a")],
      [],
      owner,
    );
    const [epoch] = built.epochs;
    expect(epoch!.stored.form.campaign.version).toMatch(/^1\.0\.0\+ext\./);
    expect(epoch!.extensions).toEqual([{ id: "x", extends: "core-a" }]);
    expect(epoch!.extensionsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses the publication when core uses the reserved identifier", () => {
    expect(() =>
      buildCandidate([campaign("core-a", "1.0.0+ext.1")], [], [], owner),
    ).toThrow(CoreContentError);
  });

  it("quarantines a submission that uses the reserved identifier, alone", () => {
    const built = buildCandidate(
      [campaign("core-a")],
      [],
      [
        { sourceId: "bad", portable: campaign("sub", "2.0.0+ext.1") },
        { sourceId: "good", portable: campaign("other") },
      ],
      owner,
    );
    expect(built.quarantined.map((q) => q.sourceId)).toEqual(["bad"]);
    expect(built.quarantined[0]!.reason).toMatch(/reserve/);
    expect(built.epochs.map((e) => e.stored.form.campaign.id)).toEqual([
      "core-a",
      "other",
    ]);
  });

  it("accepts a key already held under the same content", () => {
    const first = buildCandidate([campaign("core-a")], [], [], owner);
    const held = first.epochs[0]!.stored;
    const again = buildCandidate([campaign("core-a")], [], [], owner, () => ({
      digest: held.digest,
      extensionsDigest: undefined,
    }));
    expect(again.epochs[0]!.stored.digest).toBe(held.digest);
  });

  it("quarantines a submission edited under a version already held", () => {
    const first = buildCandidate(
      [],
      [],
      [{ sourceId: "s1", portable: campaign("sub") }],
      owner,
    );
    const held = first.epochs[0]!.stored.digest;
    const edited = buildCandidate(
      [campaign("core-a")],
      [],
      [{ sourceId: "s1", portable: campaign("sub", "1.0.0", "A new end.") }],
      owner,
      (id) =>
        id === "sub"
          ? { digest: held, extensionsDigest: undefined }
          : undefined,
    );
    expect(edited.quarantined).toEqual([
      {
        sourceId: "s1",
        reason: expect.stringMatching(/^content_version_conflict/),
      },
    ]);
    expect(edited.epochs.map((e) => e.stored.form.campaign.id)).toEqual([
      "core-a",
    ]);
  });

  it("refuses the publication when core is edited under a version already held", () => {
    expect(() =>
      buildCandidate(
        [campaign("core-a", "1.0.0", "A new end.")],
        [],
        [],
        owner,
        () => ({ digest: "0".repeat(64), extensionsDigest: undefined }),
      ),
    ).toThrow(/content_version_conflict/);
  });

  it("names a derived-version collision apart from an edit", () => {
    const built = buildCandidate(
      [campaign("core-a")],
      [extension("x", "core-a")],
      [],
      owner,
    );
    const { extensionsDigest } = built.epochs[0]!;
    const other =
      extensionsDigest!.slice(0, -1) +
      (extensionsDigest!.endsWith("0") ? "1" : "0");
    expect(() =>
      buildCandidate(
        [campaign("core-a")],
        [extension("x", "core-a")],
        [],
        owner,
        () => ({ digest: "0".repeat(64), extensionsDigest: other }),
      ),
    ).toThrow(/derived_version_collision/);
  });
});
