/**
 * Integration tests against a real Postgres -- `DATABASE_URL` must point at a running
 * instance with the migrations applied (server/docker-compose.yml's `db` service, which
 * publishes 5432 to the host for exactly this reason, locally; the
 * `postgres:17` service container in CI's `server` job). Exercises the properties the
 * plan's Verification section names: port conformance (durability, not just the
 * in-memory cache), replay verify (byte-identical, and a genuine mismatch), and
 * cross-player authorization.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string")
    throw new Error("no Set-Cookie header in response");
  return value.split(";")[0]!;
}

describeIfDb("server API", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    app = await buildApp(pool, "http://localhost:5173");
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  async function guestCookie(): Promise<string> {
    const response = await app.inject({ method: "GET", url: "/api/me" });
    return cookieFrom(response);
  }

  it("mints a guest identity on first contact", async () => {
    const response = await app.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "guest" });
  });

  it("lists the campaign catalog", async () => {
    const response = await app.inject({ method: "GET", url: "/api/campaigns" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { campaigns: { campaignId: string }[] };
    expect(
      body.campaigns.some((c) => c.campaignId === "what-would-lucifer-do"),
    ).toBe(true);
  });

  it("accepts a bodyless POST declaring application/json (saveGame, resumeSession, loadGame all send this)", async () => {
    // Regression: RemoteSessionStore (src/play/remote-store.ts) used to set
    // `content-type: application/json` on every request regardless of whether it sent a
    // body. Fastify's JSON parser rejects that combination outright
    // (FST_ERR_CTP_EMPTY_JSON_BODY), which turned every save/resume/load in remote mode
    // into a 500 -- caught by an end-to-end browser run, not by app.inject() defaults,
    // since inject() doesn't set this header unless asked. Pinned here explicitly.
    const cookie = await guestCookie();
    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: { campaignId: "what-would-lucifer-do" },
      })
      .then((r) => r.json() as { sessionId: string });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/save`,
      headers: { cookie, "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("persists a session across a fresh store instance (port conformance)", async () => {
    const cookie = await guestCookie();

    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: {
          campaignId: "what-would-lucifer-do",
          seed: "conformance-seed",
        },
      })
      .then((r) => r.json() as { sessionId: string });

    await app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/actions`,
      headers: { cookie },
      payload: { actionId: "laugh" },
    });

    // Discard this store and build a fresh one over the same Postgres -- proves
    // durability, not the in-memory write-through cache.
    const freshApp = await buildApp(pool, "http://localhost:5173");
    const resumed = await freshApp.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/resume`,
      headers: { cookie },
    });
    await freshApp.close();

    expect(resumed.statusCode).toBe(200);
    const scene = (resumed.json() as { scene: { body: { text: string } } })
      .scene;
    expect(scene.body.text).toContain("Correct");
  });

  it("verifies a played session replays byte-identical, and catches a corrupted blob", async () => {
    const cookie = await guestCookie();
    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: { campaignId: "what-would-lucifer-do", seed: "verify-seed" },
      })
      .then((r) => r.json() as { sessionId: string });

    await app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/actions`,
      headers: { cookie },
      payload: { actionId: "laugh" },
    });

    const verified = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/replay/verify`,
      headers: { cookie },
    });
    expect(verified.json()).toMatchObject({ ok: true });

    await pool.query(
      `update sessions set blob = replace(blob, '"turn":2', '"turn":99') where session_id = $1`,
      [created.sessionId],
    );

    const corrupted = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/replay/verify`,
      headers: { cookie },
    });
    expect(corrupted.json()).toMatchObject({ ok: false });
  });

  it("denies a session to a player who does not own it", async () => {
    const ownerCookie = await guestCookie();
    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ownerCookie },
        payload: { campaignId: "what-would-lucifer-do", seed: "auth-seed" },
      })
      .then((r) => r.json() as { sessionId: string });

    const strangerCookie = await guestCookie();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${created.sessionId}/scene`,
      headers: { cookie: strangerCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("branches a session at a past step without mutating the original", async () => {
    const cookie = await guestCookie();
    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: { campaignId: "what-would-lucifer-do", seed: "branch-seed" },
      })
      .then((r) => r.json() as { sessionId: string });

    const startingScene = await app
      .inject({
        method: "GET",
        url: `/api/sessions/${created.sessionId}/scene`,
        headers: { cookie },
      })
      .then((r) => r.json());

    await app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/actions`,
      headers: { cookie },
      payload: { actionId: "laugh" },
    });

    const afterActionScene = await app
      .inject({
        method: "GET",
        url: `/api/sessions/${created.sessionId}/scene`,
        headers: { cookie },
      })
      .then((r) => r.json());

    // atSeq: 1 replays exactly the one submitted action -- the branch should land on the
    // same scene the original session is already sitting on, under a new session id.
    const branchedAtCurrent = await app
      .inject({
        method: "POST",
        url: `/api/sessions/${created.sessionId}/branch`,
        headers: { cookie },
        payload: { atSeq: 1 },
      })
      .then((r) => r.json() as { sessionId: string; scene: unknown });
    expect(branchedAtCurrent.sessionId).not.toBe(created.sessionId);
    expect(branchedAtCurrent.scene).toEqual(afterActionScene);

    // atSeq: 0 replays nothing -- a genuine "branch from the past", landing back on the
    // starting scene rather than where the original session is now.
    const branchedAtStart = await app
      .inject({
        method: "POST",
        url: `/api/sessions/${created.sessionId}/branch`,
        headers: { cookie },
        payload: { atSeq: 0 },
      })
      .then((r) => r.json() as { sessionId: string; scene: unknown });
    expect(branchedAtStart.scene).toEqual(startingScene);

    // The original session's own state is untouched by either branch.
    const stillAfterAction = await app
      .inject({
        method: "GET",
        url: `/api/sessions/${created.sessionId}/scene`,
        headers: { cookie },
      })
      .then((r) => r.json());
    expect(stillAfterAction).toEqual(afterActionScene);
  });
});
