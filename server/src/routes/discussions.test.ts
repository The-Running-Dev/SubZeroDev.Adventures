/**
 * `/api/discussions/*` -- same `buildApp` + `app.inject` style as `admin.test.ts`. The
 * `DiscussionForum` seam is the injection point (`AppConfig.discussionForum`), so this
 * suite never touches the network -- a hand-written fake stands in, and `discussions/
 * github.test.ts` covers the real GraphQL adapter separately against a loopback server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import {
  type DiscussionForum,
  DiscussionForumError,
  type DiscussionThread,
  type DiscussionThreadDetail,
  type DiscussionThreadPage,
} from "../discussions/forum.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string")
    throw new Error("no Set-Cookie header in response");
  return value.split(";")[0]!;
}

function fakeThread(
  id: string,
  overrides: Partial<DiscussionThread> = {},
): DiscussionThread {
  return {
    id,
    title: `thread ${id}`,
    excerpt: "an excerpt",
    authorLogin: "sza-bot",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    commentCount: 0,
    url: `https://github.com/o/r/discussions/${id}`,
    ...overrides,
  };
}

interface FakeForum extends DiscussionForum {
  readonly calls: { list: number; get: number; create: number };
  page: DiscussionThreadPage;
  detail: DiscussionThreadDetail | undefined;
  failWith: DiscussionForumError | undefined;
  lastCreateTitle: string | undefined;
  lastCreateBody: string | undefined;
  lastCreateAuthorLabel: string | undefined;
}

function makeFakeForum(): FakeForum {
  const fake: FakeForum = {
    name: "fake",
    calls: { list: 0, get: 0, create: 0 },
    page: { threads: [fakeThread("1")] },
    detail: {
      thread: fakeThread("1"),
      body: "the full body",
      comments: [],
      moreComments: false,
    },
    failWith: undefined,
    lastCreateTitle: undefined,
    lastCreateBody: undefined,
    lastCreateAuthorLabel: undefined,
    async listThreads() {
      fake.calls.list++;
      if (fake.failWith) throw fake.failWith;
      return fake.page;
    },
    async getThread() {
      fake.calls.get++;
      if (fake.failWith) throw fake.failWith;
      return fake.detail;
    },
    async createThread(input) {
      fake.calls.create++;
      if (fake.failWith) throw fake.failWith;
      fake.lastCreateTitle = input.title;
      fake.lastCreateBody = input.body;
      fake.lastCreateAuthorLabel = input.authorLabel;
      return fakeThread("42", { title: input.title });
    },
  };
  return fake;
}

describeIfDb("discussion routes (configured)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let fake: FakeForum;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    fake = makeFakeForum();
    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
      discussionForum: fake,
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate discussion_posts, content_sources, badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
    fake.calls.list = 0;
    fake.calls.get = 0;
    fake.calls.create = 0;
    fake.page = { threads: [fakeThread("1")] };
    fake.detail = {
      thread: fakeThread("1"),
      body: "the full body",
      comments: [],
      moreComments: false,
    };
    fake.failWith = undefined;
  });

  async function guestCookie(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { campaignId: "what-would-lucifer-do" },
    });
    return cookieFrom(response);
  }

  async function memberCookie(displayName = "Ada"): Promise<string> {
    const cookie = await guestCookie();
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    await pool.query(
      `update players set kind = 'member', display_name = $2 where player_id = $1`,
      [playerId, displayName],
    );
    return cookie;
  }

  async function playerCount(): Promise<number> {
    const { rows } = await pool.query("select count(*)::int as n from players");
    return rows[0].n as number;
  }

  // --- reads ---

  it("lists threads for a cookieless caller and mints no player row", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/discussions",
    });
    expect(response.statusCode).toBe(200);
    expect(await playerCount()).toBe(0);
    const body = response.json() as { canPost: boolean; threads: unknown[] };
    expect(body.canPost).toBe(false);
    expect(body.threads).toHaveLength(1);
  });

  it("reports canPost by principal kind", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/discussions" });
    expect((anon.json() as { canPost: boolean }).canPost).toBe(false);

    const guest = await guestCookie();
    const asGuest = await app.inject({
      method: "GET",
      url: "/api/discussions",
      headers: { cookie: guest },
    });
    expect((asGuest.json() as { canPost: boolean }).canPost).toBe(false);

    const member = await memberCookie();
    const asMember = await app.inject({
      method: "GET",
      url: "/api/discussions",
      headers: { cookie: member },
    });
    expect((asMember.json() as { canPost: boolean }).canPost).toBe(true);
  });

  it("shows the forum's own author when no local attribution exists", async () => {
    fake.page = { threads: [fakeThread("1", { authorLogin: "sza-bot" })] };
    const response = await app.inject({
      method: "GET",
      url: "/api/discussions",
    });
    const [entry] = (
      response.json() as {
        threads: { authorName: string; authorKind: string }[];
      }
    ).threads;
    expect(entry!.authorKind).toBe("forum");
    expect(entry!.authorName).toBe("sza-bot");
  });

  it("attributes a thread to the local player who posted it, masked", async () => {
    const member = await memberCookie("ripcord@example.com");
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: member },
    });
    const { playerId } = me.json() as { playerId: string };
    await pool.query(
      `insert into discussion_posts (discussion_ref, player_id, title) values ('1', $1, 'thread 1')`,
      [playerId],
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/discussions",
    });
    const [entry] = (
      response.json() as {
        threads: { authorName: string; authorKind: string }[];
      }
    ).threads;
    expect(entry!.authorKind).toBe("player");
    expect(entry!.authorName).toBe("Anonymous Operator"); // display_name is email-shaped
  });

  it("shows Anonymous Operator for a null upstream login", async () => {
    fake.page = { threads: [fakeThread("1", { authorLogin: null })] };
    const response = await app.inject({
      method: "GET",
      url: "/api/discussions",
    });
    const [entry] = (response.json() as { threads: { authorName: string }[] })
      .threads;
    expect(entry!.authorName).toBe("Anonymous Operator");
  });

  it("returns a thread with its comments", async () => {
    fake.detail = {
      thread: fakeThread("1"),
      body: "full body text",
      comments: [
        {
          id: "c1",
          body: "a reply",
          authorLogin: "someone",
          createdAt: "2026-01-01T00:00:00.000Z",
          url: "https://github.com/o/r/discussions/1#c1",
        },
      ],
      moreComments: true,
    };
    const response = await app.inject({
      method: "GET",
      url: "/api/discussions/1",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      body: string;
      comments: unknown[];
      moreComments: boolean;
    };
    expect(body.body).toBe("full body text");
    expect(body.comments).toHaveLength(1);
    expect(body.moreComments).toBe(true);
  });

  it("answers 404 not_found when the forum has no such thread", async () => {
    fake.detail = undefined;
    const response = await app.inject({
      method: "GET",
      url: "/api/discussions/1",
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });

  it("rejects an out-of-pattern thread id before touching the forum", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/api/discussions/bad%20id",
    });
    expect(bad.statusCode).toBe(400);
    const tooLong = await app.inject({
      method: "GET",
      url: `/api/discussions/${"a".repeat(65)}`,
    });
    expect(tooLong.statusCode).toBe(400);
    expect(fake.calls.get).toBe(0);
  });

  it("validates limit and cursor query parameters", async () => {
    for (const limit of ["0", "51", "abc"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/discussions?limit=${limit}`,
      });
      expect(response.statusCode).toBe(400);
    }
    const ok = await app.inject({
      method: "GET",
      url: "/api/discussions?limit=10",
    });
    expect(ok.statusCode).toBe(200);
  });

  it("answers 503 forum_unavailable when the forum throws", async () => {
    fake.failWith = new DiscussionForumError("unavailable", "boom");
    const response = await app.inject({
      method: "GET",
      url: "/api/discussions",
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "forum_unavailable",
    );
    expect(JSON.stringify(response.json())).not.toContain("boom");
  });

  // --- writes ---

  it("refuses a cookieless POST and mints no player row", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      payload: { title: "hello", body: "world" },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "members_only",
    );
    expect(await playerCount()).toBe(0);
    expect(fake.calls.create).toBe(0);
  });

  it("refuses a guest POST", async () => {
    const cookie = await guestCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "hello", body: "world" },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "members_only",
    );
  });

  it("lets a member post, recording attribution", async () => {
    const cookie = await memberCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: {
        title: "  My thread  ",
        body: "  a real question\r\n\r\nwith detail  ",
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      thread: { id: string; authorKind: string; authorName: string };
    };
    expect(body.thread.authorKind).toBe("player");
    expect(body.thread.authorName).toBe("Ada");
    expect(fake.lastCreateTitle).toBe("My thread");
    expect(fake.lastCreateBody).toBe("a real question\n\nwith detail");
    expect(fake.lastCreateAuthorLabel).toBe("Ada");

    const { rows } = await pool.query(
      "select discussion_ref, title from discussion_posts where discussion_ref = $1",
      [body.thread.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(
      body.thread.id === "42" ? "My thread" : rows[0].title,
    );
  });

  it.each([
    ["empty title", { title: "", body: "b" }, "invalid_title"],
    ["whitespace-only title", { title: "   ", body: "b" }, "invalid_title"],
    [
      "over-length title",
      { title: "x".repeat(121), body: "b" },
      "invalid_title",
    ],
    ["empty body", { title: "t", body: "" }, "invalid_body"],
    [
      "over-length body",
      { title: "t", body: "x".repeat(4001) },
      "invalid_body",
    ],
    [
      "body with a control character",
      { title: "t", body: "hi\u0000there" },
      "invalid_body",
    ],
  ])("rejects %s", async (_label, payload, code) => {
    const cookie = await memberCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      code,
    );
    expect(fake.calls.create).toBe(0);
  });

  it("accepts a title at the length boundary and a body with a plain newline", async () => {
    const cookie = await memberCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "x".repeat(120), body: "line one\nline two" },
    });
    expect(response.statusCode).toBe(201);
  });

  it("rate-limits a member past the daily post cap", async () => {
    const cookie = await memberCookie();
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `insert into discussion_posts (discussion_ref, player_id, title) values ($1, $2, 't')`,
        [`seed-${i}`, playerId],
      );
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "one more", body: "b" },
    });
    expect(response.statusCode).toBe(429);
    expect(fake.calls.create).toBe(0);
  });

  it("does not count posts older than the rolling day window", async () => {
    const cookie = await memberCookie();
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `insert into discussion_posts (discussion_ref, player_id, title, created_at)
         values ($1, $2, 't', now() - interval '2 days')`,
        [`seed-${i}`, playerId],
      );
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "still allowed", body: "b" },
    });
    expect(response.statusCode).toBe(201);
  });

  it("returns 503 and writes no attribution row when the forum create fails, without spending quota", async () => {
    fake.failWith = new DiscussionForumError("unavailable", "boom");
    const cookie = await memberCookie();
    const failed = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "t", body: "b" },
    });
    expect(failed.statusCode).toBe(503);
    const { rows } = await pool.query(
      "select count(*)::int as n from discussion_posts",
    );
    expect(rows[0].n).toBe(0);

    fake.failWith = undefined;
    const succeeded = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "t", body: "b" },
    });
    expect(succeeded.statusCode).toBe(201);
  });

  it("still lets a member post after their cookie was minted before the kind flip", async () => {
    const cookie = await guestCookie();
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    await pool.query(
      `update players set kind = 'member' where player_id = $1`,
      [playerId],
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "t", body: "b" },
    });
    expect(response.statusCode).toBe(201);
  });
});

describeIfDb("discussion routes (unconfigured)", () => {
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
      "truncate discussion_posts, content_sources, badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  it("answers 503 not_configured on both read routes", async () => {
    const list = await app.inject({ method: "GET", url: "/api/discussions" });
    expect(list.statusCode).toBe(503);
    expect((list.json() as { error: { code: string } }).error.code).toBe(
      "not_configured",
    );

    const thread = await app.inject({
      method: "GET",
      url: "/api/discussions/1",
    });
    expect(thread.statusCode).toBe(503);
    expect((thread.json() as { error: { code: string } }).error.code).toBe(
      "not_configured",
    );
  });

  it("answers 503 not_configured on POST once past the member gate", async () => {
    // The member gate runs first regardless of configuration -- a cookieless or guest
    // POST always answers 403 members_only, configured or not (covered in the configured
    // suite above). This is the "not configured" answer for the one caller who can get
    // past that gate.
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { campaignId: "what-would-lucifer-do" },
    });
    const cookie = cookieFrom(response);
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    await pool.query(
      `update players set kind = 'member' where player_id = $1`,
      [playerId],
    );

    const post = await app.inject({
      method: "POST",
      url: "/api/discussions",
      headers: { cookie },
      payload: { title: "t", body: "b" },
    });
    expect(post.statusCode).toBe(503);
    expect((post.json() as { error: { code: string } }).error.code).toBe(
      "not_configured",
    );
  });
});
