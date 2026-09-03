/**
 * `cachedDiscussionForum` against a fake `DiscussionForum` -- no network, no Postgres. The
 * injected clock drives freshness/expiry deterministically rather than sleeping.
 */
import { describe, expect, it, vi } from "vitest";
import { cachedDiscussionForum } from "./cache.js";
import {
  type DiscussionForum,
  DiscussionForumError,
  type DiscussionThreadDetail,
  type DiscussionThreadPage,
} from "./forum.js";

function fakePage(n: number): DiscussionThreadPage {
  return {
    threads: [
      {
        id: String(n),
        title: `thread ${n}`,
        excerpt: "e",
        authorLogin: "bot",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        commentCount: 0,
        url: `https://example.test/${n}`,
      },
    ],
  };
}

function fakeDetail(id: string): DiscussionThreadDetail {
  return {
    thread: fakePage(Number(id)).threads[0]!,
    body: "b",
    comments: [],
    moreComments: false,
  };
}

function fakeForum(): DiscussionForum & {
  calls: { list: number; get: number; create: number };
} {
  const calls = { list: 0, get: 0, create: 0 };
  return {
    name: "fake",
    calls,
    async listThreads() {
      calls.list++;
      return fakePage(1);
    },
    async getThread(id) {
      calls.get++;
      return fakeDetail(id);
    },
    async createThread(input) {
      calls.create++;
      return { ...fakePage(99).threads[0]!, title: input.title };
    },
  };
}

describe("cachedDiscussionForum", () => {
  it("serves a second call within the TTL from cache", async () => {
    let now = 0;
    const inner = fakeForum();
    const cached = cachedDiscussionForum(inner, { now: () => now });

    await cached.listThreads();
    await cached.listThreads();

    expect(inner.calls.list).toBe(1);
  });

  it("re-fetches once the TTL elapses", async () => {
    let now = 0;
    const inner = fakeForum();
    const cached = cachedDiscussionForum(inner, {
      ttlMs: 1000,
      now: () => now,
    });

    await cached.listThreads();
    now = 1001;
    await cached.listThreads();

    expect(inner.calls.list).toBe(2);
  });

  it("joins ten concurrent misses into one upstream call", async () => {
    let now = 0;
    let resolveInner!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveInner = resolve;
    });
    const inner: DiscussionForum = {
      name: "fake",
      async listThreads() {
        await gate;
        return fakePage(1);
      },
      async getThread(id) {
        return fakeDetail(id);
      },
      async createThread(input) {
        return { ...fakePage(1).threads[0]!, title: input.title };
      },
    };
    const spy = vi.fn(inner.listThreads.bind(inner));
    const cached = cachedDiscussionForum(
      { ...inner, listThreads: spy },
      { now: () => now },
    );

    const calls = Array.from({ length: 10 }, () => cached.listThreads());
    resolveInner();
    await Promise.all(calls);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("serves the stale value when the inner call fails after a success", async () => {
    let now = 0;
    let fail = false;
    const inner: DiscussionForum = {
      name: "fake",
      async listThreads() {
        if (fail) throw new DiscussionForumError("unavailable", "boom");
        return fakePage(1);
      },
      async getThread(id) {
        return fakeDetail(id);
      },
      async createThread(input) {
        return { ...fakePage(1).threads[0]!, title: input.title };
      },
    };
    const cached = cachedDiscussionForum(inner, {
      ttlMs: 1000,
      staleMs: 5000,
      now: () => now,
    });

    await cached.listThreads();
    fail = true;
    now = 2000; // past the TTL, still within staleMs
    const page = await cached.listThreads();

    expect(page.threads[0]!.id).toBe("1");
  });

  it("rethrows when the inner call fails and nothing is cached yet", async () => {
    let now = 0;
    const inner: DiscussionForum = {
      name: "fake",
      async listThreads() {
        throw new DiscussionForumError("unavailable", "boom");
      },
      async getThread() {
        return undefined;
      },
      async createThread(input) {
        return { ...fakePage(1).threads[0]!, title: input.title };
      },
    };
    const cached = cachedDiscussionForum(inner, { now: () => now });

    await expect(cached.listThreads()).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("does not call upstream again during the failure cooldown", async () => {
    let now = 0;
    let calls = 0;
    const inner: DiscussionForum = {
      name: "fake",
      async listThreads() {
        calls++;
        throw new DiscussionForumError("unavailable", "boom");
      },
      async getThread() {
        return undefined;
      },
      async createThread(input) {
        return { ...fakePage(1).threads[0]!, title: input.title };
      },
    };
    const cached = cachedDiscussionForum(inner, {
      ttlMs: 0,
      staleMs: 0,
      failureCooldownMs: 10_000,
      now: () => now,
    });

    await expect(cached.listThreads()).rejects.toBeTruthy();
    now = 100;
    await expect(cached.listThreads()).rejects.toBeTruthy();

    expect(calls).toBe(1);
  });

  it("calls upstream again once the cooldown elapses", async () => {
    let now = 0;
    let calls = 0;
    const inner: DiscussionForum = {
      name: "fake",
      async listThreads() {
        calls++;
        throw new DiscussionForumError("unavailable", "boom");
      },
      async getThread() {
        return undefined;
      },
      async createThread(input) {
        return { ...fakePage(1).threads[0]!, title: input.title };
      },
    };
    const cached = cachedDiscussionForum(inner, {
      ttlMs: 0,
      staleMs: 0,
      failureCooldownMs: 100,
      now: () => now,
    });

    await expect(cached.listThreads()).rejects.toBeTruthy();
    now = 101;
    await expect(cached.listThreads()).rejects.toBeTruthy();

    expect(calls).toBe(2);
  });

  it("invalidates the list cache after a successful create", async () => {
    let now = 0;
    const inner = fakeForum();
    const cached = cachedDiscussionForum(inner, { now: () => now });

    await cached.listThreads();
    await cached.createThread({ title: "t", body: "b", authorLabel: "Ada" });
    await cached.listThreads();

    expect(inner.calls.list).toBe(2);
  });

  it("caches an undefined getThread result (negative caching)", async () => {
    let now = 0;
    let calls = 0;
    const inner: DiscussionForum = {
      name: "fake",
      async listThreads() {
        return fakePage(1);
      },
      async getThread() {
        calls++;
        return undefined;
      },
      async createThread(input) {
        return { ...fakePage(1).threads[0]!, title: input.title };
      },
    };
    const cached = cachedDiscussionForum(inner, { now: () => now });

    await cached.getThread("999");
    await cached.getThread("999");

    expect(calls).toBe(1);
  });

  it("evicts the least-recently-touched thread once past maxThreads", async () => {
    let now = 0;
    let calls = 0;
    const inner: DiscussionForum = {
      name: "fake",
      async listThreads() {
        return fakePage(1);
      },
      async getThread(id) {
        calls++;
        return fakeDetail(id);
      },
      async createThread(input) {
        return { ...fakePage(1).threads[0]!, title: input.title };
      },
    };
    const cached = cachedDiscussionForum(inner, {
      maxThreads: 2,
      now: () => now,
    });

    await cached.getThread("a");
    await cached.getThread("b");
    await cached.getThread("c"); // evicts "a"
    calls = 0;
    await cached.getThread("a"); // must re-fetch -- was evicted
    await cached.getThread("c"); // still cached -- no re-fetch

    expect(calls).toBe(1);
  });

  it("passes a cursored call straight through, uncached", async () => {
    let now = 0;
    const inner = fakeForum();
    const cached = cachedDiscussionForum(inner, { now: () => now });

    await cached.listThreads({ cursor: "abc" });
    await cached.listThreads({ cursor: "abc" });

    expect(inner.calls.list).toBe(2);
  });
});
