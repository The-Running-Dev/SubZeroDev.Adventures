/**
 * Environment-neutral campaign catalog building — shared between the browser composition
 * (`src/play/composition.ts`) and the server composition (`server/src/composition.ts`).
 *
 * This is the one place the non-contract `fromPortable` / `Portable*` boundary
 * (`CLAUDE.md`, "The Engine Submodule — What Not to Forget") is crossed. Keeping it in a
 * single file means a submodule bump that changes or removes that spike export breaks one
 * module, not two.
 */
import {
  buildValidatedContentRegistry,
  fromPortable,
  simulationKind,
  storyGraphKind,
  worldGraphKind,
  type ContentRegistry,
  type PortableCampaign,
} from "@the-running-dev/game-engine";

/** The declared clamp range of one visible int stat, for rendering it as a meter rather than a bare number. */
export interface StatBounds {
  readonly min?: number;
  readonly max?: number;
}

export interface CatalogEntry {
  readonly campaignId: string;
  /** The engine kind this campaign runs on (`story-graph`, `simulation`, `world-graph` --
   *  see `KINDS` below). Every shipped campaign today is `story-graph`; read by the
   *  server's `multiclass` badge (server/src/badges.ts) and available to any client that
   *  wants to group or filter by kind. */
  readonly kindId: string;
  readonly title: string;
  readonly description: string;
  readonly duration: string;
  readonly contentNotice: string;
  readonly featured: boolean;
  /** Playable and registered, but omitted from the public dossier grid — reachable only by a direct `?campaign=` link. */
  readonly hidden?: boolean;
  readonly sources?: readonly { label: string; href: string }[];
  /**
   * Declared `min`/`max` for each visible int variable, keyed by variable name.
   * Empty for a campaign whose stats are all unbounded, and for any kind that
   * does not declare variables this way.
   */
  readonly statBounds: Readonly<Record<string, StatBounds>>;
  /** Distinct terminal `endingId`s reachable in this campaign's content, for a spoiler-safe
   *  "n of m discovered" -- 0 for a kind (simulation, world-graph) that doesn't declare
   *  nodes this way, same degrade-gracefully posture as `statBoundsOf`. */
  readonly endingCount: number;
}

export const KINDS = {
  "story-graph": storyGraphKind,
  simulation: simulationKind,
  "world-graph": worldGraphKind,
} as const;

/**
 * `Campaign.content` is deliberately `unknown` to the core — kind-specific and
 * opaque (registry/types.ts). The player projection carries a stat's *value* but
 * not its declared range (`VisibleStat`, story-graph/view.ts, which omits it to
 * avoid duplicating campaign content in the view), so rendering "3 / 26" instead
 * of a bare "3" means reading the range from the campaign this client already
 * fetched.
 *
 * That makes this a read across the same non-contract boundary `CLAUDE.md` flags
 * for `fromPortable`: a story-graph `VariableSchema` shape assumed structurally,
 * not imported. It is therefore written to degrade rather than throw — a kind
 * with no `variables` (simulation, world-graph), or a variable missing the
 * fields, simply yields no bounds and the stat renders as it does today.
 */
export function statBoundsOf(content: unknown): Record<string, StatBounds> {
  const variables = (
    content as {
      variables?: Record<
        string,
        { type?: unknown; visible?: unknown; min?: unknown; max?: unknown }
      >;
    }
  )?.variables;
  if (typeof variables !== "object" || variables === null) return {};

  const bounds: Record<string, StatBounds> = {};
  for (const [name, decl] of Object.entries(variables)) {
    if (decl?.type !== "int" || decl.visible !== true) continue;
    const min = typeof decl.min === "number" ? decl.min : undefined;
    const max = typeof decl.max === "number" ? decl.max : undefined;
    if (min === undefined && max === undefined) continue;
    bounds[name] = {
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    };
  }
  return bounds;
}

/**
 * Same non-contract read as `statBoundsOf` above: `content.nodes` is a story-graph
 * structural assumption, not an imported type, and degrades to 0 for any other kind rather
 * than throwing.
 */
export function endingCountOf(content: unknown): number {
  const nodes = (
    content as {
      nodes?: Record<string, { kind?: unknown; endingId?: unknown }>;
    }
  )?.nodes;
  if (typeof nodes !== "object" || nodes === null) return 0;

  const endingIds = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node?.kind === "ending" && typeof node.endingId === "string") {
      endingIds.add(node.endingId);
    }
  }
  return endingIds.size;
}

export interface BuiltCatalog {
  readonly registry: ContentRegistry;
  /** Every registered campaign, listed and hidden. Callers filter for their own listing surface. */
  readonly all: readonly CatalogEntry[];
}

/** Hydrates portable campaigns, validates the registry, and projects the catalog entries a
 *  client needs to render a dossier — the environment-neutral half of what
 *  `createBrowserDemo` used to do inline. */
export function buildCatalog(
  portables: readonly PortableCampaign[],
): BuiltCatalog {
  const hydrated = portables.map((portable) => fromPortable(portable));

  const registry = buildValidatedContentRegistry(
    hydrated.map((h) => h.built),
    KINDS,
  );
  if (!registry.ok || !registry.value)
    throw new Error(
      `The playable catalog could not be validated: ${JSON.stringify(registry.errors)}`,
    );

  const all = hydrated.map(({ built, catalog }) => ({
    campaignId: built.campaign.id,
    kindId: built.campaign.kindId,
    title:
      registry.value!.strings.get(built.campaign.titleKey) ?? catalog.title,
    description: catalog.description,
    duration: catalog.duration,
    contentNotice: catalog.contentNotice,
    featured: catalog.featured,
    ...(catalog.hidden ? { hidden: true } : {}),
    ...(catalog.sources ? { sources: catalog.sources } : {}),
    statBounds: Object.freeze(statBoundsOf(built.campaign.content)),
    endingCount: endingCountOf(built.campaign.content),
  }));

  return { registry: registry.value, all: Object.freeze(all) };
}
