/**
 * `createHttpCampaignSource` (issue #27) against a real local HTTP server -- no mocking of
 * `fetch` itself, so what's under test is the actual request/retry/timeout behaviour, not a
 * stand-in for it. No `DATABASE_URL` needed; this never touches Postgres.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpCampaignSource } from "./source.js";

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
    const manifest = { formatVersion: 1, campaigns: ["a.json", "b.json"] };
    const campaigns: Record<string, unknown> = {
      "/manifest.json": manifest,
      "/a.json": { campaign: { id: "a" } },
      "/b.json": { campaign: { id: "b" } },
    };
    const started = await startServer((path) => ({
      status: 200,
      body: campaigns[path],
    }));
    server = started.server;

    const source = createHttpCampaignSource(started.url);
    const loaded = await source.load();

    expect(loaded).toEqual([
      { campaign: { id: "a" } },
      { campaign: { id: "b" } },
    ]);
  });

  it("loads no extensions when the manifest declares none", async () => {
    const manifest = { formatVersion: 1, campaigns: [] };
    const started = await startServer((path) =>
      path === "/manifest.json"
        ? { status: 200, body: manifest }
        : { status: 404 },
    );
    server = started.server;

    const source = createHttpCampaignSource(started.url);
    expect(await source.loadExtensions()).toEqual([]);
  });

  it("loads every extension the manifest lists", async () => {
    const manifest = {
      formatVersion: 1,
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
    expect(await source.loadExtensions()).toEqual([extension]);
  });

  it("throws rather than returning a partial catalog when one file 404s", async () => {
    const manifest = {
      formatVersion: 1,
      campaigns: ["a.json", "missing.json"],
    };
    const started = await startServer((path) => {
      if (path === "/manifest.json") return { status: 200, body: manifest };
      if (path === "/a.json")
        return { status: 200, body: { campaign: { id: "a" } } };
      return { status: 404 };
    });
    server = started.server;

    const source = createHttpCampaignSource(started.url, { retries: 0 });
    await expect(source.load()).rejects.toThrow();
  });

  it("retries a transient failure and still succeeds", async () => {
    const manifest = { formatVersion: 1, campaigns: ["a.json"] };
    let attempts = 0;
    const started = await startServer((path) => {
      if (path === "/manifest.json") return { status: 200, body: manifest };
      attempts += 1;
      // Fails the first attempt, succeeds on the retry.
      if (attempts === 1) return { status: 503 };
      return { status: 200, body: { campaign: { id: "a" } } };
    });
    server = started.server;

    const source = createHttpCampaignSource(started.url, {
      retries: 1,
      timeoutMs: 2000,
    });
    const loaded = await source.load();

    expect(loaded).toEqual([{ campaign: { id: "a" } }]);
    expect(attempts).toBe(2);
  });

  it("gives up and throws once retries are exhausted", async () => {
    const manifest = { formatVersion: 1, campaigns: ["a.json"] };
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
    const manifest = { formatVersion: 1, campaigns: ["a.json"] };
    const started = await startServer((path) =>
      path === "/manifest.json"
        ? { status: 200, body: manifest }
        : { status: 200, body: { campaign: { id: "a" } }, delayMs: 500 },
    );
    server = started.server;

    const source = createHttpCampaignSource(started.url, {
      retries: 0,
      timeoutMs: 50,
    });
    await expect(source.load()).rejects.toThrow();
  });
});
