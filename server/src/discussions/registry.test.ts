/**
 * `loadDiscussionForum` -- env-only, no network, no Postgres. Saves and restores every
 * variable it touches so this suite is safe next to `identity/registry.test.ts`-style env
 * mutation elsewhere (`vitest.config.ts` runs the server suite with `fileParallelism:
 * false`, so this is safe even without that care, but it costs nothing to be explicit).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDiscussionForum } from "./registry.js";

const VARS = [
  "DISCUSSIONS_REPO",
  "DISCUSSIONS_TOKEN",
  "DISCUSSIONS_CATEGORY",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("loadDiscussionForum", () => {
  it("is undefined when nothing is set", () => {
    expect(loadDiscussionForum()).toBeUndefined();
  });

  it("is undefined when any one of the three is missing", () => {
    process.env.DISCUSSIONS_REPO = "o/r";
    process.env.DISCUSSIONS_TOKEN = "t";
    expect(loadDiscussionForum()).toBeUndefined();
  });

  it("treats an empty string the same as unset", () => {
    process.env.DISCUSSIONS_REPO = "o/r";
    process.env.DISCUSSIONS_TOKEN = "";
    process.env.DISCUSSIONS_CATEGORY = "general";
    expect(loadDiscussionForum()).toBeUndefined();
  });

  it("throws for a malformed DISCUSSIONS_REPO rather than reporting unconfigured", () => {
    process.env.DISCUSSIONS_TOKEN = "t";
    process.env.DISCUSSIONS_CATEGORY = "general";
    for (const bad of ["noslash", "a/b/c", "/b", "a/"]) {
      process.env.DISCUSSIONS_REPO = bad;
      expect(() => loadDiscussionForum()).toThrow(/DISCUSSIONS_REPO/);
    }
  });

  it("returns a configured forum without making any network call", () => {
    process.env.DISCUSSIONS_REPO = "the-running-dev/SubZeroDev.Adventures";
    process.env.DISCUSSIONS_TOKEN = "t";
    process.env.DISCUSSIONS_CATEGORY = "general";

    const forum = loadDiscussionForum();

    expect(forum).toBeDefined();
    expect(forum!.name).toBe("github");
    expect(typeof forum!.listThreads).toBe("function");
    expect(typeof forum!.getThread).toBe("function");
    expect(typeof forum!.createThread).toBe("function");
    // Construction alone must not touch the network -- resolution is lazy (github.ts).
    // No server is listening at this endpoint, so calling a method would reject; merely
    // building the object must not.
  });
});
