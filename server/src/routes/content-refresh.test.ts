/**
 * `POST /api/content/refresh` (issue #21): the publisher's trigger. No database: the route
 * reaches nothing but the content cell, so a bare Fastify instance and a real cell over an
 * injected build are the whole fixture -- which is also the proof that it never touches
 * `principal.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ServerDemo } from "../composition.js";
import { createContentCell } from "../content-cell.js";
import { registerContentRefreshRoute } from "./content-refresh.js";

const SECRET = "a-long-enough-publisher-secret-0123456789";

function fakeDemo(campaignCount: number): ServerDemo {
  return {
    all: Array.from({ length: campaignCount }),
    core: Array.from({ length: campaignCount }),
  } as unknown as ServerDemo;
}

/** A real cell whose builder counts its calls and can be held open, so a test can have
 *  several requests in flight against one rebuild. */
async function countingCell(outcome: () => ServerDemo = () => fakeDemo(1)) {
  let builds = 0;
  let gate: Promise<void> | undefined;
  const { cell, ready } = createContentCell(async () => {
    builds += 1;
    if (gate) await gate;
    return outcome();
  });
  await ready();
  builds = 0;
  return {
    cell,
    builds: () => builds,
    hold(): () => void {
      let open!: () => void;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWith(
  cell: Awaited<ReturnType<typeof countingCell>>["cell"],
  secret: string | undefined,
) {
  app = Fastify();
  registerContentRefreshRoute(app, cell, secret);
  await app.ready();
  return app;
}

function refresh(server: FastifyInstance, authorization?: string) {
  return server.inject({
    method: "POST",
    url: "/api/content/refresh",
    ...(authorization === undefined ? {} : { headers: { authorization } }),
  });
}

describe("POST /api/content/refresh", () => {
  it("answers 503 not_configured when no secret is configured, and never rebuilds", async () => {
    const counting = await countingCell();
    const server = await appWith(counting.cell, undefined);

    const response = await refresh(server, `Bearer ${SECRET}`);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { operation: "content_refresh", code: "not_configured" },
    });
    expect(counting.builds()).toBe(0);
  });

  it.each([
    ["no Authorization header", undefined],
    ["the wrong secret", `Bearer ${SECRET}x`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 10)}`],
    ["the secret without the Bearer scheme", SECRET],
    ["an empty bearer token", "Bearer "],
    ["a different scheme", `Basic ${SECRET}`],
  ])("refuses %s with 401 and never rebuilds", async (_label, header) => {
    const counting = await countingCell();
    const server = await appWith(counting.cell, SECRET);

    const response = await refresh(server, header);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { operation: "content_refresh", code: "unauthorized" },
    });
    expect(counting.builds()).toBe(0);
  });

  it("rebuilds and publishes on the right secret", async () => {
    let campaigns = 1;
    const counting = await countingCell(() => fakeDemo(campaigns));
    const server = await appWith(counting.cell, SECRET);
    campaigns = 4;

    const response = await refresh(server, `Bearer ${SECRET}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(counting.builds()).toBe(1);
    expect(counting.cell.current().all.length).toBe(4);
  });

  it("reports a failed rebuild as 502 with its reason and keeps serving the previous catalog", async () => {
    let fail = false;
    const counting = await countingCell(() => {
      if (fail) throw new Error("collision in x");
      return fakeDemo(2);
    });
    const server = await appWith(counting.cell, SECRET);
    fail = true;

    const response = await refresh(server, `Bearer ${SECRET}`);

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ ok: false, error: "collision in x" });
    expect(counting.cell.current().all.length).toBe(2);
  });

  it("joins concurrent calls onto one rebuild", async () => {
    const counting = await countingCell();
    const server = await appWith(counting.cell, SECRET);
    const open = counting.hold();

    const calls = [0, 1, 2].map(() => refresh(server, `Bearer ${SECRET}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    open();
    const responses = await Promise.all(calls);

    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200,
    ]);
    expect(counting.builds()).toBe(1);
  });

  it("is safe to call repeatedly: each sequential call is its own rebuild", async () => {
    const counting = await countingCell();
    const server = await appWith(counting.cell, SECRET);

    for (let call = 0; call < 3; call += 1) {
      expect((await refresh(server, `Bearer ${SECRET}`)).statusCode).toBe(200);
    }

    expect(counting.builds()).toBe(3);
  });
});
