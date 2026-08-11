/**
 * Fans a refresh out across every configured content source -- the always-present hardcoded
 * default plus whatever an operator has added through the admin page (issue #27) -- and
 * merges the result into the single `CampaignSource` `composition.ts` still only ever sees
 * one of. Everything above `createMultiSourceCampaignSource` (composition.ts, the content
 * cell) is unaware multiple sources exist at all.
 *
 * Every source is fail-closed, matching #22's existing rule: one bad source aborts the
 * *whole* refresh rather than quietly shipping a smaller catalog, so the previous one keeps
 * serving. `Promise.allSettled` (not `Promise.all`) is what makes that failure attributable
 * to the row that caused it instead of an opaque "something failed" -- each source's own
 * outcome is recorded (`recordSourceOutcome`) whether the overall refresh succeeds or not.
 *
 * The one exception is an entry carrying a `fallback` -- only the hardcoded builtin does
 * (`index.ts`), and its fallback is the committed disk snapshot the repository ships anyway.
 * That entry degrades to its fallback instead of failing the refresh. This is not a hole in
 * the rule above: the rule exists so a *smaller* catalog never ships silently, and the
 * snapshot is the same content the builtin URL is meant to serve, so the catalog stays whole
 * and the failure stays visible (`degraded`, surfaced as the builtin row's `lastError`).
 * Without it, an operator cannot publish anything at all -- every paste and every added URL
 * is saved but permanently unpublishable -- for as long as one unremovable source that does
 * not exist yet keeps 404ing.
 */
import type { Pool } from "pg";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import type { PortableExtension } from "../../../shared/campaign-extension.js";
import {
  createHttpCampaignSource,
  type CampaignSource,
  type LoadedContent,
} from "./source.js";
import {
  listContentSources,
  recordSourceOutcome,
  type ContentSourceRow,
} from "../content-sources.js";

export interface SourceEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: "url" | "pasted";
  readonly url?: string;
  readonly payload?: unknown;
  /** Content to serve in this entry's place when its own load fails, instead of failing the
   *  refresh. Only the builtin has one; a DB-backed row never does, and nothing lets an
   *  operator give a row one. */
  readonly fallback?: CampaignSource;
}

export interface EntryOutcome {
  readonly sourceId: string;
  readonly label: string;
  readonly ok: boolean;
  /** Set on a failure, and *also* set alongside `ok: true` when `degraded` -- there, it is
   *  why the fallback was used, not a reason the refresh failed. */
  readonly error?: string;
  /** This entry contributed its fallback's content rather than its own. */
  readonly degraded?: boolean;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
}

export interface FanOutResult {
  readonly campaigns: readonly PortableCampaign[];
  readonly extensions: readonly PortableExtension[];
  readonly outcomes: readonly EntryOutcome[];
  readonly ok: boolean;
}

/** A pasted payload is either a whole `PortableCampaign` (has `campaign`+`catalog`) or a
 *  `PortableExtension` (has `id`+`extends`) -- the same shape check `routes/admin.ts` uses
 *  to validate a paste before it's ever saved, reused here so a row added before this check
 *  existed, or edited directly in the database, degrades to a clear error instead of a
 *  crash. */
export function classifyPastedPayload(
  payload: unknown,
): "campaign" | "extension" | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if ("campaign" in record && "catalog" in record) return "campaign";
  if ("extends" in record && "id" in record) return "extension";
  return undefined;
}

interface EntryLoad {
  readonly content: LoadedContent;
  /** Present only when `content` came from `entry.fallback` -- the primary's own error. */
  readonly degradedError?: string;
}

async function loadPrimary(entry: SourceEntry): Promise<LoadedContent> {
  if (entry.kind === "url") {
    if (!entry.url)
      throw new Error(`source "${entry.label}": a url source has no url`);
    return createHttpCampaignSource(entry.url).load();
  }
  const kind = classifyPastedPayload(entry.payload);
  if (kind === "campaign")
    return {
      campaigns: [entry.payload as PortableCampaign],
      extensions: [],
    };
  if (kind === "extension")
    return {
      campaigns: [],
      extensions: [entry.payload as PortableExtension],
    };
  throw new Error(
    `source "${entry.label}": pasted payload is neither a campaign nor an extension`,
  );
}

/** A fallback that throws too is not a second chance -- the entry then fails exactly as it
 *  would have with no fallback at all, and the refresh fails with it. */
async function loadOneEntry(entry: SourceEntry): Promise<EntryLoad> {
  try {
    return { content: await loadPrimary(entry) };
  } catch (error) {
    if (!entry.fallback) throw error;
    return {
      content: await entry.fallback.load(),
      degradedError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Never throws for a source's own fetch/shape failure -- that's what `outcomes` is for.
 * **Does** throw for a duplicate campaign id across two otherwise-successful sources: that
 * conflict belongs to no single row, so there is no `outcomes` entry it could attach to,
 * and it is checked only once every source has actually succeeded (a failed fan-out already
 * fails the refresh; layering a second, unrelated error on top would just be noise).
 */
export async function loadAllSources(
  entries: readonly SourceEntry[],
): Promise<FanOutResult> {
  const settled = await Promise.allSettled(entries.map(loadOneEntry));

  const outcomes: EntryOutcome[] = settled.map((result, index) => {
    const entry = entries[index]!;
    if (result.status === "fulfilled") {
      const { content, degradedError } = result.value;
      return {
        sourceId: entry.id,
        label: entry.label,
        ok: true,
        ...(degradedError !== undefined
          ? { degraded: true, error: degradedError }
          : {}),
        campaignCount: content.campaigns.length,
        extensionCount: content.extensions.length,
      };
    }
    const reason = result.reason;
    return {
      sourceId: entry.id,
      label: entry.label,
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  });

  const ok = outcomes.every((outcome) => outcome.ok);
  const campaigns = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.content.campaigns : [],
  );
  const extensions = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.content.extensions : [],
  );

  if (ok) {
    const seen = new Set<string>();
    for (const portable of campaigns) {
      if (seen.has(portable.campaign.id)) {
        throw new Error(
          `duplicate campaign id "${portable.campaign.id}" across content sources`,
        );
      }
      seen.add(portable.campaign.id);
    }
    // The same check for extensions, and not for symmetry: applying one extension twice is
    // *not* idempotent -- the second application hits nodes the first one already added and
    // fails deep inside the merge, naming the node rather than the source. Adding the same
    // extension twice is an ordinary operator slip (two Add & Sync clicks), so it earns an
    // error that says which id is duplicated instead of one that reads like broken content.
    const seenExtensions = new Set<string>();
    for (const extension of extensions) {
      if (seenExtensions.has(extension.id)) {
        throw new Error(
          `duplicate extension id "${extension.id}" across content sources`,
        );
      }
      seenExtensions.add(extension.id);
    }
  }

  return { campaigns, extensions, outcomes, ok };
}

function rowToEntry(row: ContentSourceRow): SourceEntry {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    ...(row.url !== undefined ? { url: row.url } : {}),
    ...(row.payload !== undefined ? { payload: row.payload } : {}),
  };
}

export interface SourceStatus {
  readonly id: string;
  readonly label: string;
  readonly url?: string;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
}

export interface MultiCampaignSource extends CampaignSource {
  /** The hardcoded default's own last-known outcome. It is never a DB row -- nothing else
   *  tracks it -- so `routes/admin.ts` reads this to list it in the sources table
   *  alongside the DB-backed ones, just without a Remove button. */
  builtinStatus(): SourceStatus;
}

/** `buildApp`'s `campaignSource` is `CampaignSource | undefined` in the general case (a
 *  test can hand it a plain disk source with no `builtinStatus` at all) -- this is how
 *  `routes/admin.ts` tells "the real multi-source is wired up" from "it isn't" without
 *  every caller needing its own duck-typed check. */
export function isMultiCampaignSource(
  source: CampaignSource,
): source is MultiCampaignSource {
  return (
    typeof (source as Partial<MultiCampaignSource>).builtinStatus === "function"
  );
}

/** The real `CampaignSource` the deployed server uses (`index.ts`). `builtin` is always
 *  prepended, first, ahead of whatever `listContentSources` returns -- not stored, not
 *  editable, not removable through `routes/admin.ts`. Give it a `fallback` and it stops
 *  being able to block a refresh; see this file's header for why that is the builtin's
 *  privilege and no other source's. */
export function createMultiSourceCampaignSource(
  pool: Pool,
  builtin: SourceEntry,
): MultiCampaignSource {
  let builtinStatus: SourceStatus = {
    id: builtin.id,
    label: builtin.label,
    ...(builtin.url !== undefined ? { url: builtin.url } : {}),
  };

  return {
    async load() {
      const dbRows = await listContentSources(pool);
      const entries: readonly SourceEntry[] = [
        builtin,
        ...dbRows.map(rowToEntry),
      ];
      const result = await loadAllSources(entries);

      // Persisted before the throw below, not after -- a failed refresh should still
      // update every row's last-known status, not just a successful one.
      await Promise.all(
        result.outcomes
          .filter((outcome) => outcome.sourceId !== builtin.id)
          .map((outcome) =>
            recordSourceOutcome(pool, outcome.sourceId, outcome),
          ),
      );
      const builtinOutcome = result.outcomes.find(
        (outcome) => outcome.sourceId === builtin.id,
      );
      if (builtinOutcome) {
        builtinStatus = builtinOutcome.ok
          ? {
              ...builtinStatus,
              lastSyncedAt: new Date().toISOString(),
              // A degraded builtin still reports its failure -- the counts below are the
              // snapshot's, and saying nothing here would turn "the content host is down"
              // into a green row nobody ever looks at again.
              lastError: builtinOutcome.degraded
                ? `serving the committed snapshot instead: ${builtinOutcome.error}`
                : undefined,
              campaignCount: builtinOutcome.campaignCount,
              extensionCount: builtinOutcome.extensionCount,
            }
          : { ...builtinStatus, lastError: builtinOutcome.error };
      }

      if (!result.ok) {
        const failed = result.outcomes.filter((outcome) => !outcome.ok);
        throw new Error(
          `content source(s) failed: ${failed
            .map((outcome) => `${outcome.label}: ${outcome.error}`)
            .join("; ")}`,
        );
      }

      return { campaigns: result.campaigns, extensions: result.extensions };
    },
    builtinStatus: () => builtinStatus,
  };
}

// `withBootstrapFallback` used to live here: it let the *first* `load()` fall back when the
// whole multi-source failed, so a broken source could not stop the process from starting.
// It only ever saw load failures, and the failure that actually crash-looped this server in
// production happened after every source had loaded successfully -- a pasted extension
// colliding with the campaign it extends, caught by validation of the merged registry. The
// guard therefore belongs where it can see that too, which is `content-cell.ts`'s `ready`
// (`app.ts` passes it the disk snapshot). Two overlapping bootstrap fallbacks, one of which
// covered a strict subset of the other, was one more than this needed.
