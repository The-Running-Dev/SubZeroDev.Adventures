/**
 * Merges extension JSON into its base campaign, before validation (issue #27) -- the same
 * non-contract boundary `statBoundsOf`/`endingCountOf` (campaign-registry.ts) already cross,
 * but a deeper read: an extension adds nodes, choices and achievements structurally, not
 * just reads a declared bound. Kept here, in this repo, rather than upstream, because
 * GameEngine#292 evaluated a kind-owned `mergeContent` and explicitly declined to build it
 * yet ("text deltas already cover the frequent cases... don't build it yet") -- this is that
 * issue's own named fallback: "doing it in the API without that export works and is the
 * fallback; a submodule bump can then break it silently."
 *
 * `mergeExtensions` runs before `fromPortable`/`buildValidatedContentRegistry`
 * (campaign-registry.ts's `buildCatalog`), so a broken extension fails validation exactly
 * where a broken authored campaign would -- there is no separate, weaker gate for injected
 * content.
 *
 * Precedence, explicit (issue #27's last "done when" box):
 *  - Extensions apply in the order given -- manifest declaration order, the same order
 *    `PortableManifestWithExtensions.extensions` lists them in.
 *  - Structure is add-only. A node id, choice id, or achievement id that already exists on
 *    the target is a **hard failure of the whole merge**, not a silent overwrite -- two
 *    extensions colliding on the same node is a bug, and the caller
 *    (`ContentCell.refresh`, server/src/content-cell.ts) is what turns a thrown error here
 *    into "the previous catalog keeps serving" rather than a partial swap.
 *  - Strings are last-wins by manifest order, mirroring the engine's own per-key string
 *    fold in `resolvePacks` (GameEngine#292: "text is delta-able today; structure is not").
 *  - An `extends` naming an unknown campaign fails the merge.
 */
import type {
  PortableCampaign,
  PortableManifest,
} from "@the-running-dev/game-engine";

export interface PortableManifestWithExtensions extends PortableManifest {
  /** Extension file names, in precedence order. Absent means none -- every manifest
   *  written before extensions existed stays valid. */
  readonly extensions?: readonly string[];
}

export interface PortableExtension {
  readonly formatVersion: 1;
  readonly id: string;
  /** The campaignId this extension adds to. Must already be registered. */
  readonly extends: string;
  /** New node ids only -- an id already on the base campaign fails the merge. */
  readonly nodes?: Readonly<Record<string, unknown>>;
  /** Appends a choice to an existing node. The node must already exist and be a `choice`
   *  node; the choice id must not already be present on it. */
  readonly addChoices?: readonly {
    readonly nodeId: string;
    readonly choice: unknown;
  }[];
  /** New achievement ids only, appended to the base campaign's achievement list. */
  readonly achievements?: readonly unknown[];
  /** Merged into the base campaign's string table, last-wins by manifest order -- may
   *  freely add keys or override ones the base campaign (or an earlier extension) already
   *  declares. */
  readonly strings?: Readonly<Record<string, string>>;
}

// Story-graph structural shapes read across the same non-contract boundary
// `statBoundsOf`/`endingCountOf` (campaign-registry.ts) already document -- not imported
// from the engine kind, since `Campaign.content` is `unknown` to the core by design.
interface StructuralChoice {
  readonly id?: unknown;
}
interface StructuralNode {
  kind?: unknown;
  choices?: StructuralChoice[];
}
interface StructuralAchievement {
  readonly id?: unknown;
}
interface StructuralContent {
  nodes?: Record<string, StructuralNode>;
  achievements?: StructuralAchievement[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** No campaign the input didn't already have, and no field this function doesn't touch
 *  changes shape -- `extensions.length === 0` returns `portables` itself, unchanged, so a
 *  manifest with no `extensions` entry costs this call nothing beyond the check. */
export function mergeExtensions(
  portables: readonly PortableCampaign[],
  extensions: readonly PortableExtension[],
): readonly PortableCampaign[] {
  if (extensions.length === 0) return portables;

  const byId = new Map<string, Mutable<PortableCampaign>>(
    portables.map((portable) => [
      portable.campaign.id,
      structuredClone(portable) as Mutable<PortableCampaign>,
    ]),
  );

  for (const extension of extensions) {
    const base = byId.get(extension.extends);
    if (!base) {
      throw new Error(
        `extension "${extension.id}" extends unknown campaign "${extension.extends}"`,
      );
    }

    const content = base.campaign.content as StructuralContent;
    content.nodes ??= {};
    content.achievements ??= [];

    for (const [nodeId, node] of Object.entries(extension.nodes ?? {})) {
      if (Object.hasOwn(content.nodes, nodeId)) {
        throw new Error(
          `extension "${extension.id}": node "${nodeId}" already exists on campaign "${extension.extends}"`,
        );
      }
      content.nodes[nodeId] = node as StructuralNode;
    }

    for (const { nodeId, choice } of extension.addChoices ?? []) {
      if (!Object.hasOwn(content.nodes, nodeId)) {
        throw new Error(
          `extension "${extension.id}": target node "${nodeId}" does not exist on campaign "${extension.extends}"`,
        );
      }
      const target = content.nodes[nodeId]!;
      if (target.kind !== "choice" || !Array.isArray(target.choices)) {
        throw new Error(
          `extension "${extension.id}": target node "${nodeId}" is not a choice node`,
        );
      }
      const choiceId = (choice as StructuralChoice).id;
      if (target.choices.some((existing) => existing.id === choiceId)) {
        throw new Error(
          `extension "${extension.id}": choice "${String(choiceId)}" already exists on node "${nodeId}"`,
        );
      }
      target.choices.push(choice as StructuralChoice);
    }

    for (const achievement of extension.achievements ?? []) {
      const achievementId = (achievement as StructuralAchievement).id;
      if (
        content.achievements.some((existing) => existing.id === achievementId)
      ) {
        throw new Error(
          `extension "${extension.id}": achievement "${String(achievementId)}" already exists on campaign "${extension.extends}"`,
        );
      }
      content.achievements.push(achievement as StructuralAchievement);
    }

    if (extension.strings) {
      base.strings = { ...base.strings, ...extension.strings };
    }
  }

  return portables.map((portable) => byId.get(portable.campaign.id)!);
}
