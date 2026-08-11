/**
 * `createHttpCampaignSource` (issue #27) against a real local HTTP server -- no mocking of
 * `fetch` itself, so what's under test is the actual request/retry/timeout behaviour, not a
 * stand-in for it. No `DATABASE_URL` needed; this never touches Postgres.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { digestPortableCampaign } from "@the-running-dev/game-engine";
import { createHttpCampaignSource } from "./source.js";

/** A manifest entry with a digest that actually matches `campaign` -- `source.ts` now
 *  verifies every fetched campaign against its manifest entry (the engine's graduated
 *  portable format), so a fixture with a stale or omitted digest fails for a reason
 *  unrelated to what each test below is actually exercising. */
function manifestEntry(
  file: string,
  id: string,
  campaign: unknown,
): { file: string; id: string; version: string; digest: string } {
  return {
    file,
    id,
    version: "1.0.0",
    digest: digestPortableCampaign(campaign),
  };
}

interface Handler {
  (path: string): { status: number; body?: unknown; delayMs?: number };
}

function startServer(
  handler: Handler,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const { status, body, delayMs } = handler(request.url ?? "/");
      const send = () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (delayMs) setTimeout(send, delayMs);
      else send();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("expected a bound TCP address");
      resolve({ server, url: `http://127.0.0.1:${address.port}/` });
    });
  });
}

describe("createHttpCampaignSource", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("loads every campaign the manifest lists", async () => {
    const campaignA = { campaign: { id: "a" } };
    const campaignB = { campaign: { id: "b" } };
    const manifest = {
      formatVersion: 2,
      campaigns: [
        manifestEntry("a.json", "a", campaignA),
        manifestEntry("b.json", "b", campaignB),
      ],
    };
    const campaigns: Record<string, unknown> = {
      "/manifest.json": manifest,
      "/a.json": campaignA,
      "/b.json": campaignB,
    };
    const started = await startServer((path) => ({
      status: 200,
      body: campaigns[path],
    }));
    server = started.server;

    const source = createHttpCampaignSource(started.url);
    const loaded = await source.load();

    expect(loaded.campaigns).toEqual([campaignA, campaignB]);
    expect(loaded.extensions).toEqual([]);
  });

  it("loads no extensions when the manifest declares none", async () => {
    const manifest = { formatVersion: 2, campaigns: [] };
    const started = await startServer((path) =>
      path === "/manifest.json"
        ? { status: 200, body: manifest }
        : { status: 404 },
    );
    server = started.server;

    const source = createHttpCampaignSource(started.url);
    expect((await source.load()).extensions).toEqual([]);
  });

  it("loads every extension the manifest lists", async () => {
    const manifest = {
      formatVersion: 2,
      campaigns: [],
      extensions: ["ext-a.json"],
    };
    const extension = {
      formatVersion: 1,
      id: "ext-a",
      extends: "a",
      nodes: {},
    };
    const files: Record<string, unknown> = {
      "/manifest.json": manifest,
      "/ext-a.json": extension,
    };
    const started = await startServer((path) => ({
      status: 200,
      body: files[path],
    }));
    server = started.server;

    const source = createHttpCampaignSource(started.url);
    const loaded = await source.load();
    expect(loaded.campaigns).toEqual([]);
    expect(loaded.extensions).toEqual([extension]);
  });

  it("throws rather than returning a partial catalog when one file 404s", async () => {
    const campaignA = { campaign: { id: "a" } };
    const manifest = {
      formatVersion: 2,
      campaigns: [
        manifestEntry("a.json", "a", campaignA),
        manifestEntry("missing.json", "missing", {
          campaign: { id: "missing" },
        }),
      ],
    };
    const started = await startServer((path) => {
      if (path === "/manifest.json") return { status: 200, body: manifest };
      if (path === "/a.json") return { status: 200, body: campaignA };
      return { status: 404 };
    });
    server = started.server;

    const source = createHttpCampaignSource(started.url, { retries: 0 });
    await expect(source.load()).rejects.toThrow();
  });

  it("retries a transient failure and still succeeds", async () => {
    const campaignA = { campaign: { id: "a" } };
    const manifest = {
      formatVersion: 2,
      campaigns: [manifestEntry("a.json", "a", campaignA)],
    };
    let attempts = 0;
    const started = await startServer((path) => {
      if (path === "/manifest.json") return { status: 200, body: manifest };
      attempts += 1;
      // Fails the first attempt, succeeds on the retry.
      if (attempts === 1) return { status: 503 };
      return { status: 200, body: campaignA };
    });
    server = started.server;

    const source = createHttpCampaignSource(started.url, {
      retries: 1,
      timeoutMs: 2000,
    });
    const loaded = await source.load();

    expect(loaded.campaigns).toEqual([campaignA]);
    expect(attempts).toBe(2);
  });

  it("gives up and throws once retries are exhausted", async () => {
    const manifest = {
      formatVersion: 2,
      campaigns: [manifestEntry("a.json", "a", { campaign: { id: "a" } })],
    };
    const started = await startServer((path) =>
      path === "/manifest.json"
        ? { status: 200, body: manifest }
        : { status: 500 },
    );
    server = started.server;

    const source = createHttpCampaignSource(started.url, { retries: 1 });
    await expect(source.load()).rejects.toThrow();
  });

  it("times out a request that never responds", async () => {
    const campaignA = { campaign: { id: "a" } };
    const manifest = {
      formatVersion: 2,
      campaigns: [manifestEntry("a.json", "a", campaignA)],
    };
    const started = await startServer((path) =>
      path === "/manifest.json"
        ? { status: 200, body: manifest }
        : { status: 200, body: campaignA, delayMs: 500 },
    );
    server = started.server;

    const source = createHttpCampaignSource(started.url, {
      retries: 0,
      timeoutMs: 50,
    });
    await expect(source.load()).rejects.toThrow();
  });
});
