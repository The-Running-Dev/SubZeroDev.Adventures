/**
 * `loadAllSources`/`classifyPastedPayload` (issue #27) -- the fan-out and merge logic in
 * isolation, independent of Postgres or `createMultiSourceCampaignSource`'s persistence
 * side effects (covered instead by `routes/admin.test.ts`, which needs a real DB for the
 * `content_sources` table anyway).
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import type { PortableExtension } from "../../../shared/campaign-extension.js";
import {
  classifyPastedPayload,
  loadAllSources,
  type SourceEntry,
} from "./multi-source.js";
import type { CampaignSource } from "./source.js";

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

  it("degrades an entry with a fallback instead of failing the refresh, and still reports why", async () => {
    const entries: SourceEntry[] = [
      {
        id: "builtin",
        label: "builtin",
        kind: "url",
        url: "http://127.0.0.1:1",
        fallback: fakeSource("snapshot"),
      },
      {
        id: "pasted",
        label: "pasted",
        kind: "pasted",
        payload: { campaign: { id: "added" }, catalog: {} },
      },
    ];

    const result = await loadAllSources(entries);

    // The whole point: content an operator added is publishable even though the builtin
    // URL is unreachable, and the catalog is still whole -- snapshot *plus* the paste.
    expect(result.ok).toBe(true);
    expect(result.campaigns.map((c) => c.campaign.id)).toEqual([
      "snapshot",
      "added",
    ]);
    const builtin = result.outcomes.find((o) => o.sourceId === "builtin")!;
    expect(builtin.ok).toBe(true);
    expect(builtin.degraded).toBe(true);
    expect(builtin.error).toMatch(/failed to fetch manifest\.json/);
    expect(builtin.campaignCount).toBe(1);
  });

  it("fails an entry whose fallback fails too, exactly as if it had none", async () => {
    const result = await loadAllSources([
      {
        id: "builtin",
        label: "builtin",
        kind: "url",
        url: "http://127.0.0.1:1",
        fallback: {
          load: async () => {
            throw new Error("no snapshot on disk either");
          },
        },
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.outcomes[0]!.error).toMatch(/no snapshot on disk either/);
  });

  it("leaves an entry with no fallback fail-closed", async () => {
    const result = await loadAllSources([
      { id: "added", label: "added", kind: "url", url: "http://127.0.0.1:1" },
      {
        id: "builtin",
        label: "builtin",
        kind: "url",
        url: "http://127.0.0.1:1",
        fallback: fakeSource("snapshot"),
      },
    ]);

    // Degrading is the builtin's privilege alone -- a broken source an operator added still
    // aborts the refresh rather than quietly dropping its content (#22).
    expect(result.ok).toBe(false);
    expect(result.outcomes.find((o) => o.sourceId === "added")!.ok).toBe(false);
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

  // Two Add & Sync clicks on the same extension. Left to the merge, this surfaces as
  // `node "x" already exists on campaign "y"` from deep inside validation -- true, and
  // useless for finding the row to delete.
  it("fails on the same extension id arriving from two sources", async () => {
    const entries: SourceEntry[] = [
      {
        id: "s1",
        label: "pasted once",
        kind: "pasted",
        payload: { id: "ext-a", extends: "base" },
      },
      {
        id: "s2",
        label: "pasted again",
        kind: "pasted",
        payload: { id: "ext-a", extends: "base" },
      },
    ];

    await expect(loadAllSources(entries)).rejects.toThrow(
      /duplicate extension id "ext-a"/,
    );
  });
});

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
