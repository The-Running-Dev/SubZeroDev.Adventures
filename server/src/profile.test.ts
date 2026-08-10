/**
 * Public/private player profiles (issue #19 follow-up) -- the visibility toggle, the
 * public-by-slug lookup, and the display-name masking rule (docs/player-model.md's
 * documented email-fallback risk).
 */
import { randomUUID } from "node:crypto";
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

describeIfDb("public/private profiles", () => {
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
      "truncate badges, achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  async function guestCookie(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { campaignId: "what-would-lucifer-do" },
    });
    return cookieFrom(response);
  }

  it("defaults to private with no slug, mints one on first going public, and keeps it stable", async () => {
    const cookie = await guestCookie();

    const initial = await app
      .inject({
        method: "GET",
        url: "/api/profile/settings",
        headers: { cookie },
      })
      .then((r) => r.json() as { public: boolean; slug: string | null });
    expect(initial).toEqual({ public: false, slug: null });

    const wentPublic = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie },
        payload: { public: true },
      })
      .then((r) => r.json() as { public: boolean; slug: string | null });
    expect(wentPublic.public).toBe(true);
    expect(wentPublic.slug).toBeTruthy();

    const wentPrivate = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie },
        payload: { public: false },
      })
      .then((r) => r.json() as { public: boolean; slug: string | null });
    expect(wentPrivate.public).toBe(false);
    // Slug persists even while private -- re-enabling reuses it rather than rotating.
    expect(wentPrivate.slug).toBe(wentPublic.slug);

    const wentPublicAgain = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie },
        payload: { public: true },
      })
      .then((r) => r.json() as { public: boolean; slug: string | null });
    expect(wentPublicAgain.slug).toBe(wentPublic.slug);
  });

  it("serves a public profile by slug with the expected aggregate shape", async () => {
    const cookie = await guestCookie();
    const { slug } = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie },
        payload: { public: true },
      })
      .then((r) => r.json() as { slug: string });

    const response = await app.inject({
      method: "GET",
      url: `/api/profile/${slug}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    for (const key of [
      "displayName",
      "joinedAt",
      "sessionsStarted",
      "sessionsFinished",
      "campaignsPlayed",
      "campaignsTotal",
      "stepsTaken",
      "endingsFound",
      "achievementsUnlocked",
      "badges",
      "records",
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(body.sessionsStarted).toBe(1);
  });

  it("counts endingsFound correctly across two campaigns sharing an ending id", async () => {
    const cookie = await guestCookie();
    const { playerId } = await app
      .inject({ method: "GET", url: "/api/me", headers: { cookie } })
      .then((r) => r.json() as { playerId: string });
    const { slug } = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie },
        payload: { public: true },
      })
      .then((r) => r.json() as { slug: string });

    // what-would-lucifer-do and its Engineer's Cut share several ending ids -- a bare
    // `count(distinct ending_id)` would collapse these two into one.
    const now = new Date().toISOString();
    await pool.query(
      `insert into sessions
         (session_id, blob, audience, attempt_counter, replay_compatible, profile_id,
          created_at, updated_at, campaign_id, status, ending_id, step_count)
       values
         ($1, '{}', 'player', 1, true, $2, $3, $3,
          'what-would-lucifer-do', 'ended', 'shared-ending', 5),
         ($4, '{}', 'player', 1, true, $2, $3, $3,
          'what-would-lucifer-do-engineers-cut', 'ended', 'shared-ending', 5)`,
      [randomUUID(), playerId, now, randomUUID()],
    );

    const body = await app
      .inject({ method: "GET", url: `/api/profile/${slug}` })
      .then((r) => r.json() as { endingsFound: number });
    expect(body.endingsFound).toBe(2);
  });

  it("404s identically for an unknown slug and a slug that has since gone private", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: "/api/profile/this-slug-does-not-exist",
    });
    expect(unknown.statusCode).toBe(404);

    const cookie = await guestCookie();
    const { slug } = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie },
        payload: { public: true },
      })
      .then((r) => r.json() as { slug: string });
    await app.inject({
      method: "POST",
      url: "/api/profile/visibility",
      headers: { cookie },
      payload: { public: false },
    });

    const nowPrivate = await app.inject({
      method: "GET",
      url: `/api/profile/${slug}`,
    });
    expect(nowPrivate.statusCode).toBe(404);
    expect(nowPrivate.json()).toEqual(unknown.json());
  });

  it("falls back to Anonymous Operator for a null display_name and for one containing @", async () => {
    const guestCookieValue = await guestCookie();
    const { slug: guestSlug } = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie: guestCookieValue },
        payload: { public: true },
      })
      .then((r) => r.json() as { slug: string });
    const guestBody = await app
      .inject({ method: "GET", url: `/api/profile/${guestSlug}` })
      .then((r) => r.json() as { displayName: string });
    expect(guestBody.displayName).toBe("Anonymous Operator");

    const emailCookie = await guestCookie();
    const { playerId } = await app
      .inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: emailCookie },
      })
      .then((r) => r.json() as { playerId: string });
    await pool.query(
      `update players set display_name = $2 where player_id = $1`,
      [playerId, "someone@example.com"],
    );
    const { slug: emailSlug } = await app
      .inject({
        method: "POST",
        url: "/api/profile/visibility",
        headers: { cookie: emailCookie },
        payload: { public: true },
      })
      .then((r) => r.json() as { slug: string });
    const emailBody = await app.inject({
      method: "GET",
      url: `/api/profile/${emailSlug}`,
    });
    const emailBodyJson = emailBody.json() as { displayName: string };
    expect(emailBodyJson.displayName).toBe("Anonymous Operator");
    expect(JSON.stringify(emailBodyJson)).not.toContain("someone@example.com");
  });
});
