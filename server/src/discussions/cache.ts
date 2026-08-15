/**
 * A small TTL cache in front of a `DiscussionForum`'s reads -- a new pattern for this
 * codebase (there is no `setInterval` anywhere in `server/src`, and every existing TTL is
 * a Postgres column, per `routes/transfer.ts`'s rate limit). It earns its place here for a
 * reason `routes/stats.ts`'s "nothing is cached" position does not cover: that comment is
 * about spending this server's *own* database budget on its *own* data, which is already
 * live by construction. This decorator instead protects a *third party's* shared,
 * finite budget -- GitHub's GraphQL rate limit is per-token, this deployment has exactly
 * one project-owned token, and that same budget backs `POST /api/discussions`. An
 * unauthenticated crawler looping on the public `GET` routes would, uncached, be able to
 * exhaust the budget that posting also depends on -- reading would disable writing. See
 * `CLAUDE.md`'s decision-log entry for the full argument, including why this stays
 * process-local rather than Postgres-backed (unlike `transfer.ts`'s rate limit, divergence
 * between replicas cannot make a read *wrong*, only cold, and this deployment runs one API
 * container to begin with).
 *
 * What is cached: the first, uncursored page of `listThreads`, and every `getThread`
 * result (including a `undefined` miss -- negative caching, so an id-enumeration probe
 * costs one upstream call per distinct id rather than one per request). A cursored list
 * call passes straight through, uncached: it is a rounding error of the traffic, and
 * caching it would multiply the key space by the cursor space for no benefit.
 *
 * No background refresh, no timer -- freshness is evaluated lazily, on read, exactly like
 * every TTL elsewhere in this codebase (a comparison against a stored timestamp, not a
 * `setInterval`). Nothing here keeps the event loop alive.
 */
import type {
  CreateThreadInput,
  DiscussionForum,
  DiscussionThreadDetail,
  DiscussionThreadPage,
} from "./forum.js";
import { DiscussionForumError } from "./forum.js";

interface Entry<T> {
  readonly value: T;
  readonly fetchedAt: number;
}

interface CacheState<T> {
  entry?: Entry<T>;
  failedAt?: number;
  lastError?: unknown;
  inFlight?: Promise<T>;
}

/**
 * One memoized read, shared by the list cache and every per-thread cache below --
 * single-flight (concurrent misses join the same in-flight promise, exactly
 * `content-cell.ts`'s `refresh` shape), serve-stale-on-error, and a failure cooldown that
 * stops a failing upstream from being hammered by every arriving reader. `state` is a
 * mutable cell the caller owns and re-passes on every call, so this function itself holds
 * no state of its own.
 */
async function withCache<T>(
  state: CacheState<T>,
  now: () => number,
  ttlMs: number,
  staleMs: number,
  failureCooldownMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const entry = state.entry;
  if (entry && now() - entry.fetchedAt < ttlMs) return entry.value;

  if (state.inFlight) return state.inFlight;

  const stale = entry !== undefined && now() - entry.fetchedAt < staleMs;
  const inCooldown =
    state.failedAt !== undefined && now() - state.failedAt < failureCooldownMs;

  if (inCooldown) {
    if (stale) return entry.value;
    throw state.lastError instanceof DiscussionForumError
      ? state.lastError
      : new DiscussionForumError(
          "unavailable",
          "discussion forum: recent failure, not retrying yet",
        );
  }

  const promise = fetcher()
    .then((value) => {
      state.entry = { value, fetchedAt: now() };
      state.failedAt = undefined;
      state.lastError = undefined;
      return value;
    })
    .catch((error: unknown) => {
      state.failedAt = now();
      state.lastError = error;
      if (stale) return entry.value;
      throw error;
    })
    .finally(() => {
      state.inFlight = undefined;
    });
  state.inFlight = promise;
  return promise;
}

export function cachedDiscussionForum(
  inner: DiscussionForum,
  options: {
    readonly ttlMs?: number;
    readonly staleMs?: number;
    readonly failureCooldownMs?: number;
    readonly maxThreads?: number;
    /** Injected clock -- so a test drives freshness/expiry by calling through a fake
     *  rather than sleeping. Defaults to the real clock. */
    readonly now?: () => number;
  } = {},
): DiscussionForum {
  const ttlMs = options.ttlMs ?? 60_000;
  const staleMs = options.staleMs ?? 120_000;
  const failureCooldownMs = options.failureCooldownMs ?? 30_000;
  const maxThreads = options.maxThreads ?? 64;
  const now = options.now ?? (() => Date.now());

  let listState: CacheState<DiscussionThreadPage> = {};

  // Insertion order doubles as recency order: `getOrCreateThreadState` re-inserts a
  // touched key at the end, so eviction (from the front) drops the least-recently-touched
  // thread first, bounding memory against an id-enumeration crawl.
  const threadStates = new Map<
    string,
    CacheState<DiscussionThreadDetail | undefined>
  >();

  function getOrCreateThreadState(
    id: string,
  ): CacheState<DiscussionThreadDetail | undefined> {
    const existing = threadStates.get(id);
    if (existing) {
      threadStates.delete(id);
      threadStates.set(id, existing);
      return existing;
    }
    const state: CacheState<DiscussionThreadDetail | undefined> = {};
    threadStates.set(id, state);
    if (threadStates.size > maxThreads) {
      const oldestKey = threadStates.keys().next().value;
      if (oldestKey !== undefined) threadStates.delete(oldestKey);
    }
    return state;
  }

  return {
    name: inner.name,

    listThreads(listOptions) {
      if (listOptions?.cursor) return inner.listThreads(listOptions);
      return withCache(listState, now, ttlMs, staleMs, failureCooldownMs, () =>
        inner.listThreads(listOptions),
      );
    },

    getThread(id) {
      const state = getOrCreateThreadState(id);
      return withCache(state, now, ttlMs, staleMs, failureCooldownMs, () =>
        inner.getThread(id),
      );
    },

    async createThread(input: CreateThreadInput) {
      const thread = await inner.createThread(input);
      // Never cached itself, and it invalidates the list cache on success -- a player who
      // just posted and lands back on the list must see their own thread, which is the one
      // staleness the TTL is not allowed to cover.
      listState = {};
      return thread;
    },
  };
}
