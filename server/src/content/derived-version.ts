/**
 * The version a campaign publishes under once extensions are merged into it (engine plan 54,
 * D2). With content-addressed epochs, an extension that changed a base campaign's content under
 * its authored version would be refused as soon as the unextended epoch was held, so a composed
 * campaign names its own composition: `<authored>+ext.<12 hex>`, or `.ext.<12 hex>` appended to
 * build metadata the author already wrote. Without extensions the authored version stands.
 *
 * Versions compare by exact string equality everywhere this server uses them. SemVer precedence
 * ignores build metadata by definition, so two compositions of one base would be "equal" under
 * it -- nothing here, or anywhere that selects a publication, may use it.
 */
import { canonicalDigest } from "@the-running-dev/game-engine";
import type { PortableExtension } from "../../../shared/campaign-extension.js";

export interface DerivedVersion {
  readonly version: string;
  /** The full 64-hex extensions digest, recorded beside the epoch; undefined when no extension
   *  applied. Only its first 12 digits are in `version`, so a different full digest under the
   *  same derived version is a collision, not the same composition. */
  readonly extensionsDigest: string | undefined;
}

/** Thrown for an authored version that already carries the reserved `ext` identifier: it could
 *  otherwise equal another composition's derived version. */
export class ReservedVersionError extends Error {
  readonly campaignId: string;
  readonly authoredVersion: string;
  constructor(campaignId: string, authoredVersion: string) {
    super(
      `campaign "${campaignId}" version "${authoredVersion}" uses the build-metadata identifier "ext", which derived versions reserve`,
    );
    this.campaignId = campaignId;
    this.authoredVersion = authoredVersion;
  }
}

function buildIdentifiers(version: string): readonly string[] {
  const plus = version.indexOf("+");
  return plus < 0 ? [] : version.slice(plus + 1).split(".");
}

/**
 * The digest input is each applied extension, in the order `mergeExtensions` applied it: its
 * id, then the payload that merge reads and its strings. `PortableExtension` has no authored
 * version of its own, so its id and payload stand for one. Excluded: timestamps, URLs, row ids
 * and the base campaign, whose authored version already names it.
 */
export function deriveVersion(
  campaignId: string,
  authoredVersion: string,
  applied: readonly PortableExtension[],
): DerivedVersion {
  if (buildIdentifiers(authoredVersion).includes("ext"))
    throw new ReservedVersionError(campaignId, authoredVersion);
  if (applied.length === 0)
    return { version: authoredVersion, extensionsDigest: undefined };

  const extensionsDigest = canonicalDigest(
    applied.map((extension) => ({
      id: extension.id,
      nodes: extension.nodes ?? {},
      addChoices: extension.addChoices ?? [],
      achievements: extension.achievements ?? [],
      strings: extension.strings ?? {},
    })),
  );
  const suffix = `ext.${extensionsDigest.slice(0, 12)}`;
  const version = authoredVersion.includes("+")
    ? `${authoredVersion}.${suffix}`
    : `${authoredVersion}+${suffix}`;
  return { version, extensionsDigest };
}
