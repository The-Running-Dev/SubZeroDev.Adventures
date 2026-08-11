/**
 * `loadAllSources`/`classifyPastedPayload` (issue #27) -- the fan-out and merge logic in
 * isolation, independent of Postgres or `createMultiSourceCampaignSource`'s persistence
 * side effects (covered instead by `routes/admin.test.ts`, which needs a real DB for the
 * `content_sources` table anyway).
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import type { PortableExtension } from "../../../shared/campaign-extension.js";
import {
  classifyPastedPayload,
  loadAllSources,
  withBootstrapFallback,
  type MultiCampaignSource,
  type SourceEntry,
  type SourceStatus,
} from "./multi-source.js";
import type { CampaignSource, LoadedContent } from "./source.js";

function startServer(
  handler: (path: string) => { status: number; body?: unknown },
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const { status, body } = handler(request.url ?? "/");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body === undefined ? "" : JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("expected a bound TCP address");
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

describe("classifyPastedPayload", () => {
  it("recognizes a portable campaign", () => {
    expect(classifyPastedPayload({ campaign: { id: "a" }, catalog: {} })).toBe(
      "campaign",
    );
  });

  it("recognizes a portable extension", () => {
    expect(classifyPastedPayload({ id: "ext-a", extends: "a" })).toBe(
      "extension",
    );
  });

  it("recognizes neither shape", () => {
    expect(classifyPastedPayload({ foo: "bar" })).toBeUndefined();
    expect(classifyPastedPayload("not an object")).toBeUndefined();
    expect(classifyPastedPayload(null)).toBeUndefined();
  });
});

describe("loadAllSources", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("merges campaigns and extensions from every successful entry", async () => {
    const entries: SourceEntry[] = [
      {
        id: "s1",
        label: "pasted campaign",
        kind: "pasted",
        payload: { campaign: { id: "a" }, catalog: {} },
      },
      {
        id: "s2",
        label: "pasted extension",
        kind: "pasted",
        payload: { id: "ext-a", extends: "a" },
      },
    ];

    const result = await loadAllSources(entries);

    expect(result.ok).toBe(true);
    expect(result.campaigns).toEqual([{ campaign: { id: "a" }, catalog: {} }]);
    expect(result.extensions).toEqual([{ id: "ext-a", extends: "a" }]);
    expect(result.outcomes).toEqual([
      {
        sourceId: "s1",
        label: "pasted campaign",
        ok: true,
        campaignCount: 1,
        extensionCount: 0,
      },
      {
        sourceId: "s2",
        label: "pasted extension",
        ok: true,
        campaignCount: 0,
        extensionCount: 1,
      },
    ]);
  });

  it("reports one entry's failure without dropping the others' outcomes", async () => {
    const entries: SourceEntry[] = [
      {
        id: "good",
        label: "good",
        kind: "pasted",
        payload: { campaign: { id: "a" }, catalog: {} },
      },
      { id: "bad", label: "bad", kind: "pasted", payload: { nonsense: true } },
    ];

    const result = await loadAllSources(entries);

    expect(result.ok).toBe(false);
    const good = result.outcomes.find((o) => o.sourceId === "good")!;
    const bad = result.outcomes.find((o) => o.sourceId === "bad")!;
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/neither a campaign nor an extension/);
  });

  it("fails a url entry with no reachable server", async () => {
    const entries: SourceEntry[] = [
      {
        id: "s1",
        label: "unreachable",
        kind: "url",
        url: "http://127.0.0.1:1",
      },
    ];
    const result = await loadAllSources(entries);
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]!.ok).toBe(false);
  });

  it("fetches a url entry over HTTP like createHttpCampaignSource does directly", async () => {
    const manifest = { formatVersion: 1, campaigns: ["a.json"] };
    const files: Record<string, unknown> = {
      "/manifest.json": manifest,
      "/a.json": { campaign: { id: "a" } },
    };
    const started = await startServer((path) => ({
      status: 200,
      body: files[path],
    }));
    server = started.server;

    const result = await loadAllSources([
      { id: "s1", label: "http", kind: "url", url: started.url },
    ]);

    expect(result.ok).toBe(true);
    expect(result.campaigns).toEqual([{ campaign: { id: "a" } }]);
  });

  it("fails the whole merge on a duplicate campaign id across sources, without attributing it to either", async () => {
    const entries: SourceEntry[] = [
      {
        id: "s1",
        label: "first",
        kind: "pasted",
        payload: { campaign: { id: "dup" }, catalog: {} },
      },
      {
        id: "s2",
        label: "second",
        kind: "pasted",
        payload: { campaign: { id: "dup" }, catalog: {} },
      },
    ];

    await expect(loadAllSources(entries)).rejects.toThrow(
      /duplicate campaign id/,
    );
  });
});

function fakeMultiSource(
  load: () => Promise<LoadedContent>,
): MultiCampaignSource {
  const status: SourceStatus = { id: "builtin", label: "builtin" };
  return { load, builtinStatus: () => status };
}

function fakeSource(campaignId: string): CampaignSource {
  return {
    async load() {
      return {
        campaigns: [
          { campaign: { id: campaignId } } as unknown as PortableCampaign,
        ],
        extensions: [] as readonly PortableExtension[],
      };
    },
  };
}

describe("withBootstrapFallback", () => {
  it("boots from the fallback when the real source fails on its very first load", async () => {
    const real = fakeMultiSource(async () => {
      throw new Error("real source unreachable");
    });
    const wrapped = withBootstrapFallback(real, fakeSource("fallback"));

    const result = await wrapped.load();
    expect(result.campaigns[0]!.campaign.id).toBe("fallback");
  });

  it("does not touch the fallback once the real source has ever succeeded", async () => {
    const load = vi.fn(async () => ({
      campaigns: [{ campaign: { id: "real" } } as unknown as PortableCampaign],
      extensions: [] as readonly PortableExtension[],
    }));
    const real = fakeMultiSource(load);
    const wrapped = withBootstrapFallback(real, fakeSource("fallback"));

    const first = await wrapped.load();
    expect(first.campaigns[0]!.campaign.id).toBe("real");

    load.mockRejectedValueOnce(new Error("a later refresh failed"));
    // A failure *after* the first success must propagate for real -- the fallback is a
    // one-time bootstrap escape hatch, not a standing safety net that would otherwise
    // quietly undermine every source's fail-closed guarantee.
    await expect(wrapped.load()).rejects.toThrow("a later refresh failed");
  });

  it("never falls back a second time even if the real source's first success never happened", async () => {
    let attempt = 0;
    const real = fakeMultiSource(async () => {
      attempt += 1;
      throw new Error(`attempt ${attempt} failed`);
    });
    const wrapped = withBootstrapFallback(real, fakeSource("fallback"));

    const first = await wrapped.load();
    expect(first.campaigns[0]!.campaign.id).toBe("fallback");

    // The real source is still broken, but the bootstrap fallback already spent its one
    // use on the first call -- a second failure propagates instead of silently re-serving
    // the fallback forever, which would hide that the real source never came back.
    await expect(wrapped.load()).rejects.toThrow("attempt 2 failed");
  });

  it("passes builtinStatus() through to the real source untouched", () => {
    const real = fakeMultiSource(async () => ({
      campaigns: [] as readonly PortableCampaign[],
      extensions: [] as readonly PortableExtension[],
    }));
    const wrapped = withBootstrapFallback(real, fakeSource("fallback"));
    expect(wrapped.builtinStatus()).toEqual(real.builtinStatus());
  });
});
