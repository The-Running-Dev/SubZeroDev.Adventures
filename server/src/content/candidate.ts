/**
 * Step 1 of a publication (engine plan 54, §3.2): what the sources say should serve, as one
 * epoch per campaign. Pure -- no database, no live archive. Core is all-or-nothing and a
 * submission is quarantined on its own, as `buildTieredCatalog` always has; this adds the two
 * checks that only exist once each campaign is its own epoch: the reserved `ext` identifier (D2)
 * and the engine archive's own publication rules (reserved keys, `~`), run against a scratch
 * archive so a refusal costs nothing.
 */
import {
  createContentArchive,
  type CampaignProvenance as AuthoredProvenance,
  type ContentRegistry,
  type PortableCampaign,
  type PortableCatalog,
  type StoredEpoch,
} from "@the-running-dev/game-engine";
import {
  buildTieredCatalog,
  hydrateCatalog,
  KINDS,
  type CandidateSource,
  type QuarantinedCandidate,
} from "../../../shared/campaign-registry.js";
import type { PortableExtension } from "../../../shared/campaign-extension.js";
import type { CampaignProvenance } from "../composition.js";
import { deriveVersion, ReservedVersionError } from "./derived-version.js";

export interface CandidateEpoch {
  readonly stored: StoredEpoch;
  /** What the engine archive publishes for this epoch; not persisted. */
  readonly registry: ContentRegistry;
  /** The portable campaign's migration spec, kept beside the form: the form has no
   *  `migrateState`, and this server derives one from data, not code. */
  readonly migration: unknown;
  readonly extensionsDigest: string | undefined;
  readonly extensions: readonly {
    readonly id: string;
    readonly extends: string;
  }[];
  readonly catalog: PortableCatalog;
  /** Null for core. */
  readonly provenance: CampaignProvenance | null;
  /** The submission sources this epoch was composed from: its base campaign's, if a
   *  submission, and each applied submission extension's (D3 §5.5). Trusted sources are never
   *  deleted, so they are not listed. */
  readonly sourceIds: readonly string[];
}

export interface Candidate {
  readonly epochs: readonly CandidateEpoch[];
  readonly quarantined: readonly QuarantinedCandidate[];
  /** The submission candidates that made it into `epochs`, base campaigns and extensions. */
  readonly accepted: readonly CandidateSource[];
}

/** A core refusal: the publication is refused and what serves keeps serving. */
export class CoreContentError extends Error {}

const EMPTY: ContentRegistry = {
  campaigns: new Map(),
  strings: new Map(),
  provenance: new Map(),
};

function codesOf(errors: readonly { code: string; path?: string }[]): string {
  return errors
    .map((e) => (e.path === undefined ? e.code : `${e.code} (${e.path})`))
    .join(", ");
}

/** The registry the engine archive holds for one campaign of a validated catalog registry. */
export function singleCampaignRegistry(
  registry: ContentRegistry,
  campaignId: string,
): ContentRegistry {
  const campaign = registry.campaigns.get(campaignId)!;
  const authored: AuthoredProvenance = registry.provenance!.get(campaignId)!;
  return {
    campaigns: new Map([[campaignId, campaign]]),
    strings: new Map(authored.strings),
    provenance: new Map([[campaignId, authored]]),
  };
}

export function buildCandidate(
  trustedPortables: readonly PortableCampaign[],
  trustedExtensions: readonly PortableExtension[],
  candidates: readonly CandidateSource[],
  provenanceOf: (sourceId: string) => CampaignProvenance,
  /** What a key already names -- in this process's archive or in `content_epochs`. A key is
   *  forever (§3.1), so a candidate naming it with different content is refused. */
  held: (
    campaignId: string,
    campaignVersion: string,
  ) =>
    | { readonly digest: string; readonly extensionsDigest: string | undefined }
    | undefined = () => undefined,
  /** Whether a key was permanently deleted (D3 §5.4). It is never published again: the
   *  submission naming it is quarantined until its author bumps the version. */
  deleted: (campaignId: string, campaignVersion: string) => boolean = () =>
    false,
): Candidate {
  let tiered;
  try {
    tiered = buildTieredCatalog(
      trustedPortables,
      trustedExtensions,
      candidates,
    );
  } catch (error) {
    throw new CoreContentError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const quarantined: QuarantinedCandidate[] = [...tiered.quarantined];
  const out = new Set(quarantined.map((q) => q.sourceId));
  const quarantine = (sourceId: string, reason: string) => {
    if (out.has(sourceId)) return;
    out.add(sourceId);
    quarantined.push({ sourceId, reason });
  };

  // Which source each base campaign came from, so a submission's refusal quarantines it and
  // every extension it carries, and the same refusal on core refuses the publication.
  const submissionOf = new Map<string, CandidateSource>();
  for (const candidate of candidates)
    if (candidate.portable)
      submissionOf.set(candidate.portable.campaign.id, candidate);
  const extensionSources = (campaignId: string) =>
    candidates.filter((c) => c.extension?.extends === campaignId);
  const refuse = (campaignId: string, reason: string) => {
    const submission = submissionOf.get(campaignId);
    if (!submission) throw new CoreContentError(reason);
    quarantine(submission.sourceId, reason);
    for (const extension of extensionSources(campaignId))
      quarantine(
        extension.sourceId,
        `its base campaign was quarantined: ${reason}`,
      );
  };

  // Settles which sources are in, then rebuilds from exactly those. Each pass can only remove
  // submissions, so it ends.
  for (;;) {
    const before = out.size;
    const live = candidates.filter((c) => !out.has(c.sourceId));
    const portables = [
      ...trustedPortables,
      ...live.flatMap((c) => (c.portable ? [c.portable] : [])),
    ];
    const extensions = [
      ...trustedExtensions,
      ...live.flatMap((c) => (c.extension ? [c.extension] : [])),
    ];

    const derived = new Map<string, ReturnType<typeof deriveVersion>>();
    for (const portable of portables) {
      const { id, version } = portable.campaign;
      try {
        derived.set(
          id,
          deriveVersion(
            id,
            version,
            extensions.filter((e) => e.extends === id),
          ),
        );
      } catch (error) {
        if (!(error instanceof ReservedVersionError)) throw error;
        refuse(id, error.message);
      }
    }
    if (out.size !== before) continue;

    const versioned = portables.map((portable) => ({
      ...portable,
      campaign: {
        ...portable.campaign,
        version: derived.get(portable.campaign.id)!.version,
      },
    })) as PortableCampaign[];
    const built = hydrateCatalog(versioned, extensions);
    // `buildTieredCatalog` already accepted this exact set under authored versions, and the
    // version is no validation input, so a failure here is a defect rather than content.
    if (!built.ok) throw new CoreContentError(built.error);

    const scratch = createContentArchive({ kinds: KINDS, initial: EMPTY });
    const epochs: CandidateEpoch[] = [];
    for (const portable of built.value.portables) {
      const { id, version } = portable.campaign;
      const registry = singleCampaignRegistry(built.value.registry, id);
      const published = scratch.publish(registry);
      if (!published.ok) {
        refuse(
          id,
          `campaign "${id}" cannot be published: ${codesOf(published.errors)}`,
        );
        continue;
      }
      const stored = scratch.stored(id, version)!;
      const { extensionsDigest } = derived.get(id)!;
      if (deleted(id, version)) {
        refuse(
          id,
          `campaign_version_deleted: campaign "${id}" version "${version}" was permanently deleted`,
        );
        continue;
      }
      const existing = held(id, version);
      if (existing && existing.digest !== stored.digest) {
        // D2: the same 12-digit suffix over a different full digest is a collision between two
        // compositions, not the same one edited -- named apart so an operator can tell them.
        const collision =
          extensionsDigest !== undefined &&
          existing.extensionsDigest !== undefined &&
          existing.extensionsDigest !== extensionsDigest;
        refuse(
          id,
          collision
            ? `derived_version_collision: campaign "${id}" version "${version}" already names a different composition`
            : `content_version_conflict: campaign "${id}" version "${version}" was already published with different content`,
        );
        continue;
      }
      const submission = submissionOf.get(id);
      const applied = extensions.filter((e) => e.extends === id);
      epochs.push({
        stored,
        registry,
        migration:
          "migration" in portable.campaign
            ? (portable.campaign.migration ?? null)
            : null,
        extensionsDigest,
        extensions: applied.map((e) => ({ id: e.id, extends: e.extends })),
        catalog: portable.catalog,
        provenance: submission ? provenanceOf(submission.sourceId) : null,
        sourceIds: [
          ...(submission ? [submission.sourceId] : []),
          ...live
            .filter((c) => c.extension && applied.includes(c.extension))
            .map((c) => c.sourceId),
        ],
      });
    }
    if (out.size !== before) continue;

    return {
      epochs,
      quarantined,
      accepted: candidates.filter((c) => !out.has(c.sourceId)),
    };
  }
}
