/**
 * Pure unit tests for the swap cell (#21, #22) -- no database, no `CampaignSource`. `build`
 * is injected directly, so what's under test is the cell's own contract: publish only on
 * success, never lose the previous value on a failed rebuild, and never let two concurrent
 * refreshes run the builder twice.
 */
import { describe, expect, it, vi } from "vitest";
import { createContentCell } from "./content-cell.js";
import type { ServerDemo } from "./composition.js";

// The cell only ever reads `.all.length`/`.core.length` off a `ServerDemo` (status()) --
// everything else is opaque to it, so a minimal stand-in is enough. `core` mirrors `all`
// here since nothing in this suite distinguishes the two tiers.
function fakeDemo(campaignCount: number): ServerDemo {
  return {
    all: Array.from({ length: campaignCount }),
    core: Array.from({ length: campaignCount }),
  } as unknown as ServerDemo;
}

describe("content cell", () => {
  it("publishes the first successful build", async () => {
    const { cell, ready } = createContentCell(async () => fakeDemo(3));
    await ready();
    expect(cell.current().all.length).toBe(3);
    expect(cell.status()).toMatchObject({
      campaignCount: 3,
      lastFailureAt: undefined,
      lastError: undefined,
    });
    expect(cell.status().lastSuccessAt).toBeDefined();
  });

  it("rejects an initial build that fails with no fallback to boot from", async () => {
    const { ready } = createContentCell(async () => {
      throw new Error("boom");
    });
    await expect(ready()).rejects.toThrow(/boom/);
  });

  // The production failure this exists for: content an operator pasted made the first build
  // fail, `ready` threw, the process exited before binding a port, and the admin API that
  // could have removed that content was the thing that never came up.
  it("boots from the fallback when the initial build fails, and says so", async () => {
    const { cell, ready } = createContentCell(async () => {
      throw new Error("extension collides with its base campaign");
    });

    await ready(async () => fakeDemo(9));

    expect(cell.current().all.length).toBe(9);
    const status = cell.status();
    expect(status.bootstrapFallback).toBe(true);
    expect(status.lastError).toMatch(/collides with its base campaign/);
    // Never "succeeded" -- what is serving is the snapshot, not the configured content.
    expect(status.lastSuccessAt).toBeUndefined();
  });

  it("clears the bootstrap flag once a later refresh succeeds", async () => {
    let broken = true;
    const { cell, ready } = createContentCell(async () => {
      if (broken) throw new Error("still broken");
      return fakeDemo(4);
    });
    await ready(async () => fakeDemo(9));
    expect(cell.status().bootstrapFallback).toBe(true);

    broken = false;
    expect(await cell.refresh()).toEqual({ ok: true });
    expect(cell.status().bootstrapFallback).toBe(false);
    expect(cell.current().all.length).toBe(4);
  });

  it("throws with both reasons when the fallback fails too", async () => {
    const { ready } = createContentCell(async () => {
      throw new Error("real content is broken");
    });

    await expect(
      ready(async () => {
        throw new Error("no snapshot either");
      }),
    ).rejects.toThrow(/real content is broken.*no snapshot either/);
  });

  it("keeps serving the previous demo when a refresh fails, and records the failure", async () => {
    let succeed = true;
    const { cell, ready } = createContentCell(async () => {
      if (!succeed) throw new Error("bad publish");
      return fakeDemo(3);
    });
    await ready();

    succeed = false;
    const result = await cell.refresh();

    expect(result).toEqual({ ok: false, error: "bad publish" });
    // The previous, successfully-built demo is still what's live -- a bad refresh never
    // takes the running server down with it.
    expect(cell.current().all.length).toBe(3);
    const status = cell.status();
    expect(status.lastError).toBe("bad publish");
    expect(status.lastFailureAt).toBeDefined();
    expect(status.lastSuccessAt).toBeDefined();
  });

  it("publishes a later successful refresh after an earlier failure", async () => {
    let campaignCount = 3;
    let shouldFail = false;
    const { cell, ready } = createContentCell(async () => {
      if (shouldFail) throw new Error("bad publish");
      return fakeDemo(campaignCount);
    });
    await ready();

    shouldFail = true;
    await cell.refresh();
    expect(cell.current().all.length).toBe(3);

    shouldFail = false;
    campaignCount = 4;
    const result = await cell.refresh();

    expect(result).toEqual({ ok: true });
    expect(cell.current().all.length).toBe(4);
    expect(cell.status().lastError).toBeUndefined();
  });

  it("joins a refresh already in flight rather than running the builder twice", async () => {
    const build = vi.fn(async () => fakeDemo(1));
    const { cell, ready } = createContentCell(build);
    await ready();
    build.mockClear();

    const [first, second] = await Promise.all([cell.refresh(), cell.refresh()]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("throws if read before the initial build has ever completed", () => {
    const { cell } = createContentCell(async () => fakeDemo(1));
    expect(() => cell.current()).toThrow(/before its first build completed/);
  });
});
