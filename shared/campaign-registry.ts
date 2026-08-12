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
import {
  mergeExtensions,
  type PortableExtension,
} from "./campaign-extension.js";

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
  /** The published content version -- a submodule bump's or an extension's contribution to
   *  it isn't visible anywhere else on this type, so the admin page (`AdminPanel.tsx`)
   *  reads it here rather than the server growing a second, admin-only projection. */
  readonly version: string;
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
  /** Set only by `routes/session.ts`'s `/api/campaigns` handler, for a submission-tier
   *  campaign the requesting viewer may see -- `true` when they are its owner. Absent for
   *  core content, and always absent from `buildCatalog`'s own construction of this type
   *  (server- and browser-side alike); nothing here ever sets it. Lets the shelf
   *  (`PlayApp.tsx`) label a player's own private or pending disk without a second fetch. */
  readonly mine?: boolean;
  /** Companion to `mine`, same scope -- absent for core content. */
  readonly visibility?: "private" | "public";
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
  /** Each registered campaign's own string keys, before the registry-wide merge — what
   *  `stringsFor` (server/src/composition.ts) intersects a session's `getStrings` response
   *  against, so a private submission's narrative text is never handed to a session playing
   *  a different campaign. Captured here because it does not exist anywhere after the merge:
   *  `registry.strings` is one flat table with no per-campaign partition. */
  readonly campaignStringKeys: ReadonlyMap<string, ReadonlySet<string>>;
}

type HydrateResult =
  | { readonly ok: true; readonly value: BuiltCatalog }
  | { readonly ok: false; readonly error: string };

/** The non-throwing core of `buildCatalog` — merges extensions into their base campaigns,
 *  hydrates, and validates, but reports failure instead of throwing so a caller building a
 *  combined catalog from several independent sources (`buildTieredCatalog` below) can decide
 *  what to do about it, the same way `multi-source.ts`'s `loadAllSources` reports a source's
 *  own failure rather than throwing through it. */
function hydrateCatalog(
  portables: readonly PortableCampaign[],
  extensions: readonly PortableExtension[],
): HydrateResult {
  let merged: readonly PortableCampaign[];
  try {
    merged = mergeExtensions(portables, extensions);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const hydrated = merged.map((portable) => fromPortable(portable));

  const registry = buildValidatedContentRegistry(
    hydrated.map((h) => h.built),
    KINDS,
  );
  if (!registry.ok || !registry.value)
    return {
      ok: false,
      error: `The playable catalog could not be validated: ${JSON.stringify(registry.errors)}`,
    };

  const all = hydrated.map(({ built, catalog }) => ({
    campaignId: built.campaign.id,
    kindId: built.campaign.kindId,
    version: built.campaign.version,
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

  const campaignStringKeys = new Map<string, ReadonlySet<string>>(
    hydrated.map(({ built }) => [
      built.campaign.id,
      new Set(built.strings.keys()),
    ]),
  );

  return {
    ok: true,
    value: {
      registry: registry.value,
      all: Object.freeze(all),
      campaignStringKeys,
    },
  };
}

/** Hydrates portable campaigns, validates the registry, and projects the catalog entries a
 *  client needs to render a dossier — the environment-neutral half of what
 *  `createBrowserDemo` used to do inline. `extensions` (issue #27) are merged into their
 *  base campaign here, strictly before hydration and validation — see
 *  `campaign-extension.ts`'s header for why the merge has to happen at this point rather
 *  than after. */
export function buildCatalog(
  portables: readonly PortableCampaign[],
  extensions: readonly PortableExtension[] = [],
): BuiltCatalog {
  const result = hydrateCatalog(portables, extensions);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export interface CandidateSource {
  readonly sourceId: string;
  readonly portable?: PortableCampaign;
  readonly extension?: PortableExtension;
}

export interface QuarantinedCandidate {
  readonly sourceId: string;
  readonly reason: string;
}

export interface TieredCatalog extends BuiltCatalog {
  /** `sourceId`s of every candidate this build could not include — a submit-time-valid row
   *  can still land here if it collides with another candidate (an unnamespaced string key,
   *  a campaign id) that only exists once both are present together. */
  readonly quarantined: readonly QuarantinedCandidate[];
  /** The trusted tier alone — builtin plus admin-added sources, none of the candidates. This
   *  is what `composition.ts` reads as `ServerDemo.core`: the platform-wide denominator for
   *  badges, public profile stats, ranking, and rarity baselines, which must not move just
   *  because a player published a submission. Free to expose: `buildTieredCatalog` already
   *  builds this as its own first step. */
  readonly trusted: BuiltCatalog;
}

/** Builds a catalog from a fail-closed trusted tier (the builtin content source plus whatever
 *  an admin has added — unchanged posture, `multi-source.ts`'s header) plus a fail-open tier
 *  of player-submitted candidates: one bad or colliding candidate is quarantined and excluded
 *  rather than failing the whole build, so no submission can take the catalog down for anyone
 *  but its own author.
 *
 *  Tries every candidate together first — the common case, and the only case that costs one
 *  build. Only on failure does it fall back to a **greedy incremental** attribution: campaigns
 *  before extensions (an extension's base campaign must already be accepted, since a submitted
 *  extension may only target a campaign its own author also submitted — enforced at submit
 *  time, not re-checked here), each list ordered by the caller (by `created_at`, so an
 *  earlier-published submission is never bumped by a newcomer it happens to collide with), one
 *  candidate tried at a time against a running accumulator. A candidate that fails to add is
 *  quarantined and the accumulator does not advance past it — this, not two independent probes
 *  against the trusted tier alone, is what correctly attributes a collision *between* two
 *  candidates (an unnamespaced string key each defines differently, say), which neither
 *  candidate would fail on its own. */
export function buildTieredCatalog(
  trustedPortables: readonly PortableCampaign[],
  trustedExtensions: readonly PortableExtension[],
  candidates: readonly CandidateSource[],
): TieredCatalog {
  const trusted = buildCatalog(trustedPortables, trustedExtensions);

  const candidatePortables = candidates.filter(
    (c): c is CandidateSource & { portable: PortableCampaign } =>
      c.portable !== undefined,
  );
  const candidateExtensions = candidates.filter(
    (c): c is CandidateSource & { extension: PortableExtension } =>
      c.extension !== undefined,
  );

  const combined = hydrateCatalog(
    [...trustedPortables, ...candidatePortables.map((c) => c.portable)],
    [...trustedExtensions, ...candidateExtensions.map((c) => c.extension)],
  );
  if (combined.ok) return { ...combined.value, quarantined: [], trusted };

  // Greedy incremental fallback: campaigns first, extensions second (see doc comment), each
  // tried one at a time against whatever has already been accepted.
  let accepted = trusted;
  let acceptedPortables = [...trustedPortables];
  let acceptedExtensions = [...trustedExtensions];
  const quarantined: QuarantinedCandidate[] = [];

  for (const candidate of candidatePortables) {
    const attempt = hydrateCatalog(
      [...acceptedPortables, candidate.portable],
      acceptedExtensions,
    );
    if (attempt.ok) {
      accepted = attempt.value;
      acceptedPortables = [...acceptedPortables, candidate.portable];
    } else {
      quarantined.push({ sourceId: candidate.sourceId, reason: attempt.error });
    }
  }
  for (const candidate of candidateExtensions) {
    const attempt = hydrateCatalog(acceptedPortables, [
      ...acceptedExtensions,
      candidate.extension,
    ]);
    if (attempt.ok) {
      accepted = attempt.value;
      acceptedExtensions = [...acceptedExtensions, candidate.extension];
    } else {
      quarantined.push({ sourceId: candidate.sourceId, reason: attempt.error });
    }
  }

  return { ...accepted, quarantined, trusted };
}
