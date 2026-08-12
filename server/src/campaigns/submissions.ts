/**
 * Loads player-submitted `content_sources` rows (migration 013) for the fail-open tier
 * `composition.ts` merges alongside the trusted tier (`multi-source.ts`). Each row is loaded
 * independently -- a fetch/parse failure here is this row's own outcome, recorded the same
 * way a trusted source's would be, and never fails the build for anyone else. Whether a
 * candidate that *does* load ends up in the published catalog is a separate question
 * `buildTieredCatalog` (`shared/campaign-registry.ts`) answers -- a row can load fine here and
 * still be quarantined there for colliding with another candidate.
 *
 * Every owner row is loaded regardless of `status`/`visibility` -- an owner plays their own
 * draft, rejected submission, or pending request immediately (CLAUDE.md's "Owner play"
 * decision); only *public* visibility depends on approval, and that filtering happens after
 * this, on the catalog listing and session-creation checks in `composition.ts`, not here.
 */
import type { PortableCampaign } from "@the-running-dev/game-engine";
import type { PortableExtension } from "../../../shared/campaign-extension.js";
import type { CandidateSource } from "../../../shared/campaign-registry.js";
import {
  listContentSources,
  recordSourceOutcome,
  type ContentSourceRow,
} from "../content-sources.js";
import { loadPrimary, rowToEntry } from "./multi-source.js";
import { safeFetch } from "./safe-fetch.js";
import type { Pool } from "pg";

// Materially shorter than the trusted tier's 10s x 3 attempts (`source.ts`'s defaults) -- a
// refresh fans out to every submitted `url` row at once, and a player's unreachable host
// should not be able to make an ordinary refresh take minutes.
const USER_URL_TIMEOUT_MS = 5_000;
const USER_URL_RETRIES = 0;

export interface SubmissionLoadResult {
  readonly candidates: readonly CandidateSource[];
  /** Every attempted row, by id -- `composition.ts` uses this to look up a candidate's
   *  `ownerPlayerId`/`visibility` after `buildTieredCatalog` decides which ones made it in. */
  readonly rowsById: ReadonlyMap<string, ContentSourceRow>;
}

export async function loadSubmissionCandidates(
  pool: Pool,
): Promise<SubmissionLoadResult> {
  const rows = (await listContentSources(pool)).filter(
    (row) => row.ownerPlayerId !== undefined,
  );
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  const settled = await Promise.allSettled(
    rows.map((row) =>
      loadPrimary(rowToEntry(row), {
        timeoutMs: USER_URL_TIMEOUT_MS,
        retries: USER_URL_RETRIES,
        fetchImpl: safeFetch,
      }),
    ),
  );

  // Two passes: the first resolves every row to exactly one campaign or extension (or a
  // failure); the second enforces that an extension only ever targets a campaign *this same
  // owner* also submitted (CLAUDE.md's "Extensions are the one payload kind that cannot
  // simply be scoped to an owner" -- an extension mutates its base campaign in place, so a
  // core-targeting or another-owner-targeting one is rejected here even if `routes/content.ts`
  // somehow let it through at submit time). The second pass needs every row's own campaign id
  // resolved first, which is why this cannot happen inside the first pass's own loop.
  const resolved = new Map<
    string,
    | { readonly kind: "campaign"; readonly portable: PortableCampaign }
    | { readonly kind: "extension"; readonly extension: PortableExtension }
  >();

  await Promise.all(
    settled.map(async (result, index) => {
      const row = rows[index]!;
      if (result.status === "rejected") {
        const reason = result.reason;
        await recordSourceOutcome(pool, row.id, {
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
        return;
      }

      const { campaigns, extensions } = result.value;
      // A submission is one campaign or one extension -- the same shape the admin paste
      // flow this was ported from accepts (`classifyPastedPayload`), not a whole manifest's
      // worth. A `url` row resolving to more than one of either is this row's own failure,
      // not something silently truncated to "the first one".
      if (campaigns.length + extensions.length !== 1) {
        await recordSourceOutcome(pool, row.id, {
          ok: false,
          error: `a submission must resolve to exactly one campaign or extension (got ${campaigns.length} campaign(s), ${extensions.length} extension(s))`,
        });
        return;
      }

      if (campaigns[0]) {
        resolved.set(row.id, { kind: "campaign", portable: campaigns[0] });
      } else {
        resolved.set(row.id, { kind: "extension", extension: extensions[0]! });
      }
    }),
  );

  const ownerByCampaignId = new Map<string, string>();
  for (const [sourceId, entry] of resolved) {
    if (entry.kind === "campaign") {
      ownerByCampaignId.set(
        entry.portable.campaign.id,
        rowsById.get(sourceId)!.ownerPlayerId!,
      );
    }
  }

  const candidates: CandidateSource[] = [];
  await Promise.all(
    Array.from(resolved.entries()).map(async ([sourceId, entry]) => {
      if (entry.kind === "campaign") {
        candidates.push({ sourceId, portable: entry.portable });
        return;
      }
      const owner = rowsById.get(sourceId)!.ownerPlayerId!;
      const baseOwner = ownerByCampaignId.get(entry.extension.extends);
      if (baseOwner !== owner) {
        await recordSourceOutcome(pool, sourceId, {
          ok: false,
          error: `an extension may only extend a campaign its own author submitted (extends "${entry.extension.extends}")`,
        });
        return;
      }
      candidates.push({ sourceId, extension: entry.extension });
    }),
  );

  return { candidates, rowsById };
}
