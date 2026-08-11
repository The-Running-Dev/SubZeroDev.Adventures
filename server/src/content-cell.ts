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
  readonly contentDigest: string | undefined;
  readonly lastSuccessAt: string | undefined;
  readonly lastFailureAt: string | undefined;
  readonly lastError: string | undefined;
  /** The server booted from `ready`'s fallback because the real build failed, and no refresh
   *  has succeeded since. What is being served is not what the configured sources say. */
  readonly bootstrapFallback: boolean;
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
  /**
   * Runs `build` once and publishes it before returning -- `app.ts` awaits this so the
   * server never serves an unpopulated cell.
   *
   * `fallbackBuild` is what keeps content an operator added from being able to *brick* the
   * server rather than merely fail a refresh. #22's rule ("a bad rebuild must not take the
   * server down") held for every rebuild after the first and nowhere else: one unusable
   * source -- a pasted extension that collides with its base campaign, say -- failed the
   * very first build, `ready` threw, the process exited before binding a port, and the only
   * surface that could have removed that source was the API that never came up. Under
   * `restart: unless-stopped` that is a crash loop with no way in but psql.
   *
   * So a failed first build now boots from `fallbackBuild` (the committed disk snapshot,
   * `index.ts`) instead of throwing, keeping `lastError` and `bootstrapFallback` set so the
   * admin page can say what happened and let an operator fix it the ordinary way. Only if
   * the fallback fails too is there genuinely nothing to serve, and that throws.
   */
  ready(fallbackBuild?: () => Promise<ServerDemo>): Promise<void>;
} {
  let demo: ServerDemo | undefined;
  let inFlight: Promise<RefreshResult> | undefined;
  let lastSuccessAt: string | undefined;
  let lastFailureAt: string | undefined;
  let lastError: string | undefined;
  let bootstrapFallback = false;

  async function doRefresh(): Promise<RefreshResult> {
    try {
      const next = await build();
      demo = next;
      lastSuccessAt = new Date().toISOString();
      lastError = undefined;
      bootstrapFallback = false;
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
        contentDigest: demo?.contentDigest,
        lastSuccessAt,
        lastFailureAt,
        lastError,
        bootstrapFallback,
      };
    },
  };

  return {
    cell,
    async ready(fallbackBuild) {
      const result = await refresh();
      if (result.ok) return;
      if (!fallbackBuild)
        throw new Error(`initial content build failed: ${result.error}`);
      try {
        demo = await fallbackBuild();
        bootstrapFallback = true;
      } catch (fallbackError) {
        // Both the real content and the snapshot that stands in for it are unusable, so
        // there is nothing to serve at all -- the one case where refusing to start is
        // still right. Both reasons, because the second one alone explains nothing.
        const message =
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
        throw new Error(
          `initial content build failed: ${result.error} (the bootstrap fallback failed too: ${message})`,
        );
      }
    },
  };
}
