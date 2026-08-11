/**
 * The one indirection point between "content changed" and "the running server serves it" —
 * issue #21 (nothing can rebuild the catalog without a restart) and #22 (a bad rebuild must
 * not take the server down with it). `createServerDemo` (composition.ts) already builds a
 * complete `ServerDemo` from scratch on every call; this wraps that in a cell that only ever
 * publishes a build that finished successfully; every route re-reads `current()` per request
 * rather than closing over a snapshot the way `app.ts` used to.
 */
import type { ServerDemo } from "./composition.js";

export interface ContentStatus {
  readonly campaignCount: number;
  readonly lastSuccessAt: string | undefined;
  readonly lastFailureAt: string | undefined;
  readonly lastError: string | undefined;
}

export interface RefreshResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface ContentCell {
  /** The currently-published `ServerDemo`. Throws if the initial build never completed --
   *  `createContentCell` is only ever handed to callers after awaiting that first build, so
   *  this is a programming-error guard, not a runtime state a request can hit. */
  current(): ServerDemo;
  /** Builds a fresh `ServerDemo` and publishes it only on success. A refresh already in
   *  flight is joined rather than duplicated -- concurrent callers get the same result,
   *  never an interleaved rebuild. */
  refresh(): Promise<RefreshResult>;
  status(): ContentStatus;
}

/** `build` is `() => createServerDemo(pool)` -- this file knows nothing about `Pool` or
 *  `CampaignSource`; it only knows how to publish or reject a rebuild. */
export function createContentCell(build: () => Promise<ServerDemo>): {
  cell: ContentCell;
  /** Runs `build` once and publishes it before returning -- `app.ts` awaits this so the
   *  server never serves an unpopulated cell. */
  ready(): Promise<void>;
} {
  let demo: ServerDemo | undefined;
  let inFlight: Promise<RefreshResult> | undefined;
  let lastSuccessAt: string | undefined;
  let lastFailureAt: string | undefined;
  let lastError: string | undefined;

  async function doRefresh(): Promise<RefreshResult> {
    try {
      const next = await build();
      demo = next;
      lastSuccessAt = new Date().toISOString();
      lastError = undefined;
      return { ok: true };
    } catch (error) {
      lastFailureAt = new Date().toISOString();
      lastError = error instanceof Error ? error.message : String(error);
      return { ok: false, error: lastError };
    }
  }

  function refresh(): Promise<RefreshResult> {
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  const cell: ContentCell = {
    current() {
      if (!demo)
        throw new Error("content cell read before its first build completed");
      return demo;
    },
    refresh,
    status() {
      return {
        campaignCount: demo?.all.length ?? 0,
        lastSuccessAt,
        lastFailureAt,
        lastError,
      };
    },
  };

  return {
    cell,
    async ready() {
      const result = await refresh();
      if (!result.ok)
        throw new Error(`initial content build failed: ${result.error}`);
    },
  };
}
