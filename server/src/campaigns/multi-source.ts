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
}

export interface EntryOutcome {
  readonly sourceId: string;
  readonly label: string;
  readonly ok: boolean;
  readonly error?: string;
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

async function loadOneEntry(entry: SourceEntry): Promise<LoadedContent> {
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
      return {
        sourceId: entry.id,
        label: entry.label,
        ok: true,
        campaignCount: result.value.campaigns.length,
        extensionCount: result.value.extensions.length,
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
    result.status === "fulfilled" ? result.value.campaigns : [],
  );
  const extensions = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value.extensions : [],
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
 *  editable, not removable through `routes/admin.ts`. */
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
              lastError: undefined,
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

/**
 * `ContentCell.refresh()`/`ready()` (content-cell.ts) never publish a failed build, which
 * is exactly right for a *re*fresh -- the previous catalog keeps serving. It is exactly
 * wrong for the *first* build: there is no previous catalog yet, so a `source` that fails
 * on its very first `load()` (the hardcoded default does, until
 * `SubZeroDev.Adventures.Content` exists to serve it -- `index.ts`) would leave `ready()`
 * with nothing to publish, and it throws -- taking the whole process down before it ever
 * binds a port.
 *
 * Wraps `source` so its first `load()` falls back to `fallback` if and only if that first
 * attempt fails, then gets out of the way permanently: every later call reaches `source`
 * directly and stays exactly as fail-closed as every other source. `builtinStatus()` passes
 * through untouched, so the admin page always shows `source`'s own real outcome, never the
 * fallback's.
 */
export function withBootstrapFallback(
  source: MultiCampaignSource,
  fallback: CampaignSource,
): MultiCampaignSource {
  let firstLoadDone = false;
  return {
    async load() {
      try {
        const result = await source.load();
        firstLoadDone = true;
        return result;
      } catch (error) {
        if (firstLoadDone) throw error;
        firstLoadDone = true;
        return fallback.load();
      }
    },
    builtinStatus: () => source.builtinStatus(),
  };
}
