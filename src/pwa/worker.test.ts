/// <reference types="node" />
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker(clientCount = 1) {
  const handlers: Record<string, (event: any) => void> = {};
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    match: vi.fn().mockResolvedValue(new Response("shell")),
  };
  const self = {
    location: { origin: "https://adventures.test" },
    addEventListener: (name: string, fn: (event: any) => void) => {
      handlers[name] = fn;
    },
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn().mockResolvedValue(Array(clientCount).fill({})),
    },
    skipWaiting: vi.fn(),
  };
  const source = readFileSync("src/pwa/worker.js", "utf8").replace(
    "/* PRECACHE */ []",
    '["/index.html", "/assets/app-abcd.js"]',
  );
  const RequestStub = class {
    constructor(url: string, options: unknown) {
      Object.assign(this, { url, options });
    }
  };
  runInNewContext(source, {
    self,
    caches: { open: async () => cache },
    URL,
    Request: RequestStub,
    fetch: vi.fn(),
  });
  return { handlers, cache, self };
}

describe("service worker privacy and lifecycle", () => {
  it.each([
    ["GET", "/api/campaigns", "cors"],
    ["GET", "/api/me", "cors"],
    ["GET", "/api/progress", "cors"],
    ["GET", "/api/profile", "navigate"],
    ["POST", "/api/sessions/run/actions", "cors"],
    ["GET", "/api/saves", "cors"],
    ["GET", "/api/content", "cors"],
    ["GET", "/auth/callback", "navigate"],
    ["GET", "/campaigns/manifest.json", "cors"],
    ["GET", "/assets/missing.js", "navigate"],
    ["GET", "/assets/app-abcd.js?private=1", "cors"],
    ["GET", "https://api.test/api/campaigns", "cors"],
  ])("never intercepts %s %s", (method, path, mode) => {
    const { handlers } = worker();
    const respondWith = vi.fn();
    handlers.fetch({
      request: {
        method,
        mode,
        url: new URL(path, "https://adventures.test").href,
      },
      respondWith,
    });
    expect(respondWith).not.toHaveBeenCalled();
  });
  it("serves a cached shell for a direct route without caching its personalized URL", async () => {
    const { handlers, cache } = worker();
    const respondWith = vi.fn();
    handlers.fetch({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://adventures.test/profile?user=private",
      },
      respondWith,
    });
    expect(await (await respondWith.mock.calls[0][0]).text()).toBe("shell");
    expect(cache.match).toHaveBeenCalledWith("/index.html");
  });
  it("serves the shell for every navigation route the router declares", () => {
    // The allowlist restates src/app/routes.tsx, and nothing in the build couples them.
    // A route missing from ROUTES is not a visible failure anywhere: online, Caddy's
    // navigation fallback still returns index.html. It only surfaces as a browser error
    // page on an installed cold start, offline. Derive the table and check it here.
    const paths = [
      ...readFileSync("src/app/routes.tsx", "utf8").matchAll(
        /<Route\s+(index|path="([^"]+)")/g,
      ),
    ]
      .map((match) => (match[1] === "index" ? "" : match[2]))
      .filter((path) => path !== "*")
      .map((path) => `/${path.replaceAll(/:[^/]+/g, "sample")}`);
    expect(paths).toContain("/");
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      const { handlers } = worker();
      const respondWith = vi.fn();
      handlers.fetch({
        request: {
          method: "GET",
          mode: "navigate",
          url: new URL(path, "https://adventures.test").href,
        },
        respondWith,
      });
      expect(respondWith, `no cached shell for ${path}`).toHaveBeenCalled();
    }
  });
  it("does not activate during installation and fails incomplete precaching", async () => {
    const { handlers, cache, self } = worker();
    cache.addAll.mockRejectedValue(new Error("quota"));
    const waitUntil = vi.fn();
    handlers.install({ waitUntil });
    await expect(waitUntil.mock.calls[0][0]).rejects.toThrow("quota");
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });
  it("only activates an explicitly requested update with no other open tabs", async () => {
    for (const count of [1, 2]) {
      const { handlers, self } = worker(count);
      const waitUntil = vi.fn();
      const postMessage = vi.fn();
      handlers.message({
        data: { type: "ACTIVATE_UPDATE" },
        source: { postMessage },
        waitUntil,
      });
      await waitUntil.mock.calls[0][0];
      expect(self.skipWaiting).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
      expect(postMessage).toHaveBeenCalledTimes(count === 2 ? 1 : 0);
    }
  });
});
