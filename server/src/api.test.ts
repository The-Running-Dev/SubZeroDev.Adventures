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
    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate content_sources, badges, achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  // A bare GET no longer mints (see "does not mint a guest on a bare GET" below) --
  // every other test needs a real cookie to attach to its own requests, so this goes
  // through the one route that always mints: creating a session.
  async function guestCookie(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { campaignId: "what-would-lucifer-do" },
    });
    return cookieFrom(response);
  }

  it("mints a guest identity on first contact", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { campaignId: "what-would-lucifer-do" },
    });
    expect(response.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: cookieFrom(response) },
    });
    expect(me.json()).toMatchObject({ kind: "guest" });
  });

  it("does not mint a guest on a bare GET (/api/me, /api/saves)", async () => {
    const me = await app.inject({ method: "GET", url: "/api/me" });
    expect(me.headers["set-cookie"]).toBeUndefined();
    expect(me.json()).toMatchObject({ playerId: null, kind: "anonymous" });

    const saves = await app.inject({ method: "GET", url: "/api/saves" });
    expect(saves.headers["set-cookie"]).toBeUndefined();
    expect(saves.json()).toMatchObject({ saves: [] });

    const { rows } = await pool.query("select count(*)::int from players");
    expect(rows[0].count).toBe(0);
  });

  it("serves platform-wide stats with no cookie and mints nothing", async () => {
    const response = await app.inject({ method: "GET", url: "/api/stats" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    const body = response.json() as Record<string, unknown>;
    // Guards the ::int casts in stats.ts -- `pg` returns an uncast count as a string.
    for (const key of [
      "players",
      "sessions",
      "sessionsFinished",
      "campaignsPlayed",
      "stepsTaken",
      "achievementsUnlocked",
      "badgesUnlocked",
    ]) {
      expect(typeof body[key]).toBe("number");
    }
    const { rows } = await pool.query("select count(*)::int from players");
    expect(rows[0].count).toBe(0);
  });

  it("evaluates badges for a guest and returns an empty list for an anonymous request", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/badges" });
    expect(anonymous.headers["set-cookie"]).toBeUndefined();
    expect(anonymous.json()).toEqual({ badges: [], records: null });

    const cookie = await guestCookie();
    const first = await app.inject({
      method: "GET",
      url: "/api/badges",
      headers: { cookie },
    });
    const body = first.json() as {
      badges: { badgeId: string; unlockedAt: string }[];
    };
    expect(body.badges.map((b) => b.badgeId)).toContain("first-steps");

    // Idempotent: re-evaluating doesn't move unlockedAt for a badge already held.
    const second = await app.inject({
      method: "GET",
      url: "/api/badges",
      headers: { cookie },
    });
    const secondBody = second.json() as {
      badges: { badgeId: string; unlockedAt: string }[];
    };
    expect(
      secondBody.badges.find((b) => b.badgeId === "first-steps")?.unlockedAt,
    ).toBe(body.badges.find((b) => b.badgeId === "first-steps")?.unlockedAt);
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
    const freshApp = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
    });
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

  it("refuses one of two concurrent moves against the same session rather than losing it", async () => {
    const cookie = await guestCookie();
    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: {
          campaignId: "what-would-lucifer-do",
          seed: "concurrency-seed",
        },
      })
      .then((r) => r.json() as { sessionId: string });

    // Two independent store instances over the same Postgres -- the "two tabs" scenario,
    // and the shape a second replica would produce. Each has its own in-memory cache and
    // its own per-session lock, so nothing in-process serializes these two submissions
    // against each other; only the compare-and-swap in persistence.ts's `sessions.put`
    // can.
    const tabA = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
    });
    const tabB = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
    });
    try {
      // Both read the same starting state before either writes, by resuming first --
      // mirroring two tabs that both loaded the session before either player moved.
      await tabA.inject({
        method: "POST",
        url: `/api/sessions/${created.sessionId}/resume`,
        headers: { cookie },
      });
      await tabB.inject({
        method: "POST",
        url: `/api/sessions/${created.sessionId}/resume`,
        headers: { cookie },
      });

      const [resultA, resultB] = await Promise.all([
        tabA.inject({
          method: "POST",
          url: `/api/sessions/${created.sessionId}/actions`,
          headers: { cookie },
          payload: { actionId: "laugh" },
        }),
        tabB.inject({
          method: "POST",
          url: `/api/sessions/${created.sessionId}/actions`,
          headers: { cookie },
          payload: { actionId: "laugh" },
        }),
      ]);

      const statuses = [resultA.statusCode, resultB.statusCode].sort();
      // Exactly one success, one explicit refusal -- never two 200s (the lost update
      // this guards against) and never a request that just hangs or times out.
      expect(statuses).toEqual([200, 503]);
    } finally {
      await tabA.close();
      await tabB.close();
    }
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

  it("denies a session with no recorded owner to anyone -- not reachable by id alone", async () => {
    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          campaignId: "what-would-lucifer-do",
          seed: "unowned-seed",
        },
      })
      .then((r) => r.json() as { sessionId: string });

    await pool.query(
      "update sessions set profile_id = null where session_id = $1",
      [created.sessionId],
    );

    const cookie = await guestCookie();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${created.sessionId}/scene`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("still 404s a nonexistent session id, rather than the ownership guard preempting it", async () => {
    const cookie = await guestCookie();
    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/00000000-0000-0000-0000-000000000000/scene",
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });

  it("denies replay of a session to a player who does not own it", async () => {
    const ownerCookie = await guestCookie();
    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ownerCookie },
        payload: {
          campaignId: "what-would-lucifer-do",
          seed: "replay-auth-seed",
        },
      })
      .then((r) => r.json() as { sessionId: string });

    const strangerCookie = await guestCookie();
    const replayResponse = await app.inject({
      method: "GET",
      url: `/api/sessions/${created.sessionId}/replay`,
      headers: { cookie: strangerCookie },
    });
    expect(replayResponse.statusCode).toBe(403);

    const branchResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${created.sessionId}/branch`,
      headers: { cookie: strangerCookie },
      payload: { atSeq: 0 },
    });
    expect(branchResponse.statusCode).toBe(403);
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

  // The internal `players.player_id` is what keeps the eventual Platform identity handover
  // (SubZeroDev.Platform design/90-decisions.md) a retrofit rather than a migration -- that
  // only holds if nothing outside `/api/me` ever echoes it back to the client, in a
  // response body or a URL, giving a caller something to correlate against another
  // player's data by. Walks every route that touches a real session/save/transfer, not
  // just the ones that historically leaked it (routes/transfer.ts's old `{ playerId }` in
  // its redeem response).
  it("keeps the internal player identifier out of every response but /api/me", async () => {
    const cookie = await guestCookie();
    const me = await app
      .inject({ method: "GET", url: "/api/me", headers: { cookie } })
      .then((r) => r.json() as { playerId: string });
    const playerId = me.playerId;
    expect(playerId).toBeTruthy();

    const otherCookie = await guestCookie();

    function assertOpaque(label: string, body: unknown): void {
      expect(JSON.stringify(body), label).not.toContain(playerId);
    }

    const created = await app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: { campaignId: "what-would-lucifer-do", seed: "opaque-seed" },
      })
      .then((r) => r.json() as { sessionId: string });
    assertOpaque("POST /api/sessions", created);

    const sessionId = created.sessionId;
    const routes: { method: "GET" | "POST"; url: string; payload?: unknown }[] =
      [
        { method: "GET", url: "/api/campaigns" },
        { method: "GET", url: "/api/saves" },
        { method: "GET", url: "/api/profile/settings" },
        { method: "GET", url: "/api/ranking" },
        { method: "POST", url: `/api/sessions/${sessionId}/resume` },
        { method: "GET", url: `/api/sessions/${sessionId}/scene` },
        { method: "GET", url: `/api/sessions/${sessionId}/view` },
        { method: "GET", url: `/api/sessions/${sessionId}/strings` },
        {
          method: "POST",
          url: `/api/sessions/${sessionId}/actions/preview`,
          payload: { actionId: "laugh" },
        },
        {
          method: "POST",
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actionId: "laugh" },
        },
        { method: "POST", url: `/api/sessions/${sessionId}/save` },
        { method: "GET", url: `/api/sessions/${sessionId}/replay` },
        { method: "POST", url: `/api/sessions/${sessionId}/replay/verify` },
        {
          method: "POST",
          url: `/api/sessions/${sessionId}/branch`,
          payload: { atSeq: 0 },
        },
      ];

    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie },
        ...(route.payload ? { payload: route.payload } : {}),
      });
      assertOpaque(`${route.method} ${route.url}`, response.json());
      expect(route.url).not.toContain(playerId);
    }

    const savedFor = await app
      .inject({ method: "GET", url: "/api/saves", headers: { cookie } })
      .then((r) => r.json() as { saves: { saveId: string }[] });
    const saveId = savedFor.saves[0]!.saveId;
    const loaded = await app.inject({
      method: "POST",
      url: `/api/saves/${saveId}/load`,
      headers: { cookie },
    });
    assertOpaque("POST /api/saves/:saveId/load", loaded.json());
    expect(`/api/saves/${saveId}/load`).not.toContain(playerId);

    const transferCreated = await app
      .inject({
        method: "POST",
        url: "/api/transfer/create",
        headers: { cookie },
      })
      .then((r) => r.json() as { code: string });
    assertOpaque("POST /api/transfer/create", transferCreated);

    const redeemed = await app.inject({
      method: "POST",
      url: "/api/transfer/redeem",
      headers: { cookie: otherCookie },
      payload: { code: transferCreated.code },
    });
    assertOpaque("POST /api/transfer/redeem", redeemed.json());

    // The one route this feature adds a *second* public identifier specifically to keep
    // this invariant true for: a public profile is reached by `profile_slug`, and its
    // response must still never contain the internal `player_id`.
    const visibility = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie },
        payload: { public: true },
      })
      .then((r) => r.json() as { slug: string });
    const publicProfile = await app.inject({
      method: "GET",
      url: `/api/profile/${visibility.slug}`,
    });
    assertOpaque("GET /api/profile/:slug", publicProfile.json());
    expect(visibility.slug).not.toContain(playerId);
  });

  // Regression for issue #14: mergePlayers used to repoint sessions and saves but not
  // achievements, so the foreign key's `on delete cascade` deleted them along with the
  // merged-away player row. This is the redeeming-device side of that bug -- the
  // second-device-sign-in side is covered directly in principal.test.ts, since exercising
  // it through routes/identity.ts needs a real OAuth round trip nothing here mocks.
  it("carries the redeeming device's achievements through a transfer-code redeem", async () => {
    const sourceCookie = await guestCookie();
    const redeemerCookie = await guestCookie();

    const redeemerId = await app
      .inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: redeemerCookie },
      })
      .then((r) => (r.json() as { playerId: string }).playerId);
    await pool.query(
      `insert into achievements (player_id, campaign_id, achievement_id) values ($1, 'test-campaign', 'chapter-one')`,
      [redeemerId],
    );

    const created = await app
      .inject({
        method: "POST",
        url: "/api/transfer/create",
        headers: { cookie: sourceCookie },
      })
      .then((r) => r.json() as { code: string });

    const redeemed = await app.inject({
      method: "POST",
      url: "/api/transfer/redeem",
      headers: { cookie: redeemerCookie },
      payload: { code: created.code },
    });
    expect(redeemed.statusCode).toBe(200);

    // rotateSession (principal.ts) deletes the redeemer's old auth_sessions row and issues
    // a fresh one bound to the merge target, so the *old* cookie no longer resolves to
    // anything -- has to pick up the Set-Cookie this response just issued, not reuse
    // redeemerCookie. That new cookie now authenticates as the source player -- the merge
    // target -- so /api/me is the one place this repo's own rules allow reading playerId
    // back (see the opacity test above), and the natural way to find where the achievement
    // should have landed.
    const mergedId = await app
      .inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: cookieFrom(redeemed) },
      })
      .then((r) => (r.json() as { playerId: string }).playerId);

    const { rows } = await pool.query(
      `select achievement_id from achievements where player_id = $1`,
      [mergedId],
    );
    expect(rows.map((row) => row.achievement_id)).toEqual(["chapter-one"]);
  });

  it("GET /api/ranking is public and never mints a player, cookie or not", async () => {
    const before = await pool.query<{ n: number }>(
      "select count(*)::int as n from players",
    );
    const response = await app.inject({ method: "GET", url: "/api/ranking" });
    expect(response.statusCode).toBe(200);
    const after = await pool.query<{ n: number }>(
      "select count(*)::int as n from players",
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("masks an email-shaped display name on the ranking board", async () => {
    const cookie = await guestCookie();
    const { playerId } = await app
      .inject({ method: "GET", url: "/api/me", headers: { cookie } })
      .then((r) => r.json() as { playerId: string });
    await pool.query(
      `update players set display_name = 'someone@example.com' where player_id = $1`,
      [playerId],
    );
    await app.inject({
      method: "POST",
      url: "/api/profile/visibility",
      headers: { cookie },
      payload: { public: true },
    });
    // Needs two more public profiles to clear the ranked-player floor for a crown, but
    // the masking rule applies to every row regardless -- this just keeps the assertion
    // from depending on that floor.
    for (let i = 0; i < 2; i++) {
      const filler = await guestCookie();
      await app.inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie: filler },
        payload: { public: true },
      });
    }

    const body = await app
      .inject({ method: "GET", url: "/api/ranking" })
      .then((r) => r.json());
    expect(JSON.stringify(body)).not.toContain("someone@example.com");
    const entries = (body as { entries: { displayName: string }[] }).entries;
    expect(
      entries.find((e) => e.displayName === "Anonymous Operator"),
    ).toBeTruthy();
  });
});
