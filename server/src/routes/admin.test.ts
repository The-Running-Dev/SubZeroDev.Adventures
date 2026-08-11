/**
 * `/api/admin/content/*` (issue #27): the swap cell's HTTP surface. Same `buildApp` +
 * `app.inject` style as `api.test.ts`, plus a direct `identities` insert to make a guest
 * "admin" -- the allowlist checks `(provider, subject)` rows, never a stored role, so that
 * is the only way to become one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const ADMIN_SUBJECT = "test-provider:test-subject";

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string")
    throw new Error("no Set-Cookie header in response");
  return value.split(";")[0]!;
}

describeIfDb("/api/admin/content", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
      adminSubjects: [ADMIN_SUBJECT],
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
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

  async function adminCookie(): Promise<string> {
    const cookie = await guestCookie();
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    const [provider, subject] = ADMIN_SUBJECT.split(":");
    await pool.query(
      `insert into identities (provider, subject, player_id) values ($1, $2, $3)`,
      [provider, subject, playerId],
    );
    return cookie;
  }

  it("refuses a refresh from a guest who isn't on the allowlist", async () => {
    const cookie = await guestCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/refresh",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a refresh with no session at all", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/refresh",
    });
    expect(response.statusCode).toBe(403);
  });

  it("lets an allowlisted admin refresh content", async () => {
    const cookie = await adminCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/refresh",
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("shows status and the catalog to anyone, but isAdmin only to an allowlisted signed-in player", async () => {
    const guest = await guestCookie();
    const guestStatus = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie: guest },
    });
    expect(guestStatus.statusCode).toBe(200);
    const guestBody = guestStatus.json() as {
      isAdmin: boolean;
      campaigns: unknown[];
      status: { campaignCount: number };
    };
    expect(guestBody.isAdmin).toBe(false);
    expect(guestBody.campaigns.length).toBeGreaterThan(0);
    expect(guestBody.status.campaignCount).toBe(guestBody.campaigns.length);

    const admin = await adminCookie();
    const adminStatus = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie: admin },
    });
    expect((adminStatus.json() as { isAdmin: boolean }).isAdmin).toBe(true);
  });
});
