/**
 * `/api/admin/content/*` (issue #27): the swap cell's HTTP surface. Same `buildApp` +
 * `app.inject` style as `api.test.ts`, plus a direct `identities` insert to make a guest
 * "admin" -- the allowlist checks `(provider, subject)` rows, never a stored role, so that
 * is the only way to become one.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import { buildApp } from "../app.js";
import { createMultiSourceCampaignSource } from "../campaigns/multi-source.js";

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

/** A minimal but fully valid story-graph `PortableCampaign` -- same shape proven against
 *  `buildValidatedContentRegistry` in `shared/campaign-extension.test.ts`'s own fixture,
 *  parameterized by id so each mock server below can serve a distinct one. */
function minimalPortableCampaign(id: string) {
  return {
    formatVersion: 1,
    catalog: {
      title: id,
      description: "d",
      duration: "5 min",
      contentNotice: "none",
      featured: false,
    },
    campaign: {
      id,
      kindId: "story-graph",
      version: "1.0.0",
      titleKey: `${id}.title`,
      content: {
        descriptionKey: `${id}.description`,
        variables: {},
        nodes: {
          start: {
            id: "start",
            kind: "choice",
            textKey: `${id}.start.text`,
            choices: [{ id: "go", labelKey: `${id}.start.go`, goto: "end" }],
          },
          end: {
            id: "end",
            kind: "ending",
            textKey: `${id}.end.text`,
            endingId: "end",
          },
        },
        startNodeId: "start",
        achievements: [],
      },
    },
    strings: {
      [`${id}.title`]: id,
      [`${id}.description`]: "d",
      [`${id}.start.text`]: "You are at the start.",
      [`${id}.start.go`]: "Go to the end",
      [`${id}.end.text`]: "The end.",
    },
  };
}

/** Serves one `manifest.json` + the campaign files it lists, matching what
 *  `createHttpCampaignSource` expects -- a local stand-in for a real content host. */
function startCampaignServer(
  campaignIds: readonly string[],
): Promise<{ server: Server; url: string }> {
  const files: Record<string, unknown> = {
    "/manifest.json": {
      formatVersion: 1,
      campaigns: campaignIds.map((id) => `${id}.json`),
    },
  };
  for (const id of campaignIds) {
    files[`/${id}.json`] = minimalPortableCampaign(id);
  }
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const body = files[request.url ?? "/"];
      response.writeHead(body === undefined ? 404 : 200, {
        "content-type": "application/json",
      });
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

  it("shows status and the catalog only to an allowlisted signed-in player", async () => {
    const guest = await guestCookie();
    const guestStatus = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie: guest },
    });
    expect(guestStatus.statusCode).toBe(403);

    const anonymousStatus = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
    });
    expect(anonymousStatus.statusCode).toBe(403);
    expect(anonymousStatus.cookies).toHaveLength(0);

    const admin = await adminCookie();
    const adminStatus = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie: admin },
    });
    expect(adminStatus.statusCode).toBe(200);
    const adminBody = adminStatus.json() as {
      isAdmin: boolean;
      campaigns: unknown[];
      status: { campaignCount: number };
    };
    expect(adminBody.isAdmin).toBe(true);
    expect(adminBody.campaigns.length).toBeGreaterThan(0);
    expect(adminBody.status.campaignCount).toBe(adminBody.campaigns.length);
  });
});

describeIfDb("/api/admin/content/sources", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let builtinServer: Server;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const builtin = await startCampaignServer(["builtin-campaign"]);
    builtinServer = builtin.server;
    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
      adminSubjects: [ADMIN_SUBJECT],
      campaignSource: createMultiSourceCampaignSource(pool, {
        id: "builtin-test",
        label: "builtin test source",
        kind: "url",
        url: builtin.url,
      }),
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await new Promise((resolve) => builtinServer.close(resolve));
  });

  beforeEach(async () => {
    await pool.query(
      "truncate content_sources, badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  // No campaign this app's builtin source serves is a valid `POST /api/sessions`
  // `campaignId` for every test below, so a cookie is minted the same way `requireAdmin`
  // itself does it for an anonymous caller: `requirePrincipal` mints and sets the cookie
  // before the allowlist check ever runs, so the 403 body doesn't matter here.
  async function cookie(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/refresh",
    });
    return cookieFrom(response);
  }

  async function adminCookie(): Promise<string> {
    const c = await cookie();
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: c },
    });
    const { playerId } = me.json() as { playerId: string };
    const [provider, subject] = ADMIN_SUBJECT.split(":");
    await pool.query(
      `insert into identities (provider, subject, player_id) values ($1, $2, $3)`,
      [provider, subject, playerId],
    );
    return c;
  }

  it("lists the builtin source, not removable, alongside the real catalog", async () => {
    const admin = await adminCookie();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie: admin },
    });
    const body = response.json() as {
      sources: { id: string; builtin: boolean; removable: boolean }[];
    };
    expect(body.sources).toEqual([
      expect.objectContaining({
        id: "builtin-test",
        builtin: true,
        removable: false,
      }),
    ]);
  });

  it("adds a URL source, refreshes automatically, and the merged catalog shows it", async () => {
    const admin = await adminCookie();
    const added = await startCampaignServer(["second-campaign"]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/content/sources",
        headers: { cookie: admin },
        payload: { kind: "url", label: "second", url: added.url },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as {
        source: { id: string; label: string };
        refresh: { ok: boolean };
      };
      expect(body.refresh.ok).toBe(true);

      const status = await app.inject({
        method: "GET",
        url: "/api/admin/content/status",
        headers: { cookie: admin },
      });
      const statusBody = status.json() as {
        campaigns: { campaignId: string }[];
        sources: { id: string; campaignCount?: number }[];
      };
      expect(
        statusBody.campaigns.some((c) => c.campaignId === "second-campaign"),
      ).toBe(true);
      const addedSource = statusBody.sources.find(
        (s) => s.id === body.source.id,
      );
      expect(addedSource?.campaignCount).toBe(1);
    } finally {
      await new Promise((resolve) => added.server.close(resolve));
    }
  });

  // The difference an operator has to be able to see: a refresh is fail-closed across every
  // source, so a perfectly good paste lands on a failed refresh whenever some *other* source
  // is broken. `source.lastError` is what distinguishes that from "your paste is broken" --
  // it must be absent here even though `refresh.ok` is false.
  it("reports the added source's own outcome, not just the whole refresh's", async () => {
    const admin = await adminCookie();
    const broken = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: admin },
      payload: {
        kind: "url",
        label: "unreachable",
        url: "http://127.0.0.1:1/",
      },
    });
    expect(broken.statusCode).toBe(201);
    const brokenBody = broken.json() as {
      source: { lastError?: string };
      refresh: { ok: boolean };
    };
    expect(brokenBody.refresh.ok).toBe(false);
    expect(brokenBody.source.lastError).toBeDefined();

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: admin },
      payload: {
        kind: "pasted",
        payload: minimalPortableCampaign("late-campaign"),
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      source: { lastError?: string; campaignCount?: number };
      refresh: { ok: boolean; error?: string };
    };
    expect(body.refresh.ok).toBe(false);
    expect(body.source.lastError).toBeUndefined();
    expect(body.source.campaignCount).toBe(1);
  });

  it("adds a pasted campaign with an auto-derived label", async () => {
    const admin = await adminCookie();
    const payload = minimalPortableCampaign("pasted-campaign");

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: admin },
      payload: { kind: "pasted", payload },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      source: { label: string };
      refresh: { ok: boolean };
    };
    expect(body.source.label).toBe("pasted-campaign");
    expect(body.refresh.ok).toBe(true);
  });

  it("adds a pasted extension whose choice is selectable in a live session", async () => {
    const admin = await adminCookie();
    const extension = {
      formatVersion: 1,
      id: "test-extension",
      extends: "builtin-campaign",
      nodes: {
        side_quest: {
          id: "side_quest",
          kind: "ending",
          textKey: "ext.side_quest.text",
          endingId: "side_quest",
        },
      },
      addChoices: [
        {
          nodeId: "start",
          choice: {
            id: "take_side_quest",
            labelKey: "ext.side_quest.label",
            goto: "side_quest",
          },
        },
      ],
      strings: {
        "ext.side_quest.text": "A side quest.",
        "ext.side_quest.label": "Take the side quest",
      },
    };

    const added = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: admin },
      payload: { kind: "pasted", payload: extension },
    });
    expect((added.json() as { refresh: { ok: boolean } }).refresh.ok).toBe(
      true,
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: admin },
      payload: { campaignId: "builtin-campaign" },
    });
    const { sessionId } = created.json() as { sessionId: string };

    const result = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/actions`,
      headers: { cookie: admin },
      payload: { actionId: "take_side_quest" },
    });
    expect(result.statusCode).toBe(200);
  });

  it("rejects a pasted payload that is neither a campaign nor an extension", async () => {
    const admin = await adminCookie();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: admin },
      payload: { kind: "pasted", payload: { nonsense: true } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to remove the builtin source", async () => {
    const admin = await adminCookie();
    const response = await app.inject({
      method: "DELETE",
      url: "/api/admin/content/sources/builtin-test",
      headers: { cookie: admin },
    });
    expect(response.statusCode).toBe(400);
  });

  it("removes an added source", async () => {
    const admin = await adminCookie();
    const payload = minimalPortableCampaign("removable-campaign");
    const added = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: admin },
      payload: { kind: "pasted", payload },
    });
    const { source } = added.json() as { source: { id: string } };

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/content/sources/${source.id}`,
      headers: { cookie: admin },
    });
    expect(removed.statusCode).toBe(200);

    const status = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie: admin },
    });
    const statusBody = status.json() as { sources: { id: string }[] };
    expect(statusBody.sources.some((s) => s.id === source.id)).toBe(false);
  });

  it("refuses add/remove from a non-admin, same as refresh", async () => {
    const guest = await cookie();
    const addResponse = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: guest },
      payload: {
        kind: "pasted",
        payload: minimalPortableCampaign("unauthorized-campaign"),
      },
    });
    expect(addResponse.statusCode).toBe(403);

    const removeResponse = await app.inject({
      method: "DELETE",
      url: "/api/admin/content/sources/builtin-test",
      headers: { cookie: guest },
    });
    expect(removeResponse.statusCode).toBe(403);
  });
});

// The deployed shape: the builtin URL does not resolve (SubZeroDev.Adventures.Content does
// not exist yet) and carries the committed snapshot as its fallback. Without that fallback
// this whole suite is one assertion -- "nothing can ever be published" -- since the builtin
// is unremovable and would fail every refresh forever.
describeIfDb("/api/admin/content/sources with an unreachable builtin", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
      adminSubjects: [ADMIN_SUBJECT],
      campaignSource: createMultiSourceCampaignSource(pool, {
        id: "builtin-default",
        label: "unreachable builtin",
        kind: "url",
        url: "http://127.0.0.1:1/",
        fallback: {
          load: async () => ({
            campaigns: [
              minimalPortableCampaign(
                "snapshot-campaign",
              ) as unknown as PortableCampaign,
            ],
            extensions: [],
          }),
        },
      }),
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate content_sources, badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
  });

  async function adminCookie(): Promise<string> {
    const c = cookieFrom(
      await app.inject({ method: "POST", url: "/api/admin/content/refresh" }),
    );
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: c },
    });
    const { playerId } = me.json() as { playerId: string };
    const [provider, subject] = ADMIN_SUBJECT.split(":");
    await pool.query(
      `insert into identities (provider, subject, player_id) values ($1, $2, $3)`,
      [provider, subject, playerId],
    );
    return c;
  }

  it("publishes a pasted campaign anyway, and says the builtin is serving its snapshot", async () => {
    const admin = await adminCookie();

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/content/sources",
      headers: { cookie: admin },
      payload: {
        kind: "pasted",
        payload: minimalPortableCampaign("published-anyway"),
      },
    });

    expect(response.statusCode).toBe(201);
    expect((response.json() as { refresh: { ok: boolean } }).refresh.ok).toBe(
      true,
    );

    const status = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie: admin },
    });
    const body = status.json() as {
      campaigns: { campaignId: string }[];
      sources: { id: string; lastError?: string; campaignCount?: number }[];
    };
    // Whole catalog, not a smaller one: the snapshot the builtin stands in for, plus what
    // was just pasted -- which is playable now rather than after the content host exists.
    expect(body.campaigns.map((c) => c.campaignId).sort()).toEqual([
      "published-anyway",
      "snapshot-campaign",
    ]);
    const builtin = body.sources.find((s) => s.id === "builtin-default")!;
    expect(builtin.lastError).toMatch(/serving the committed snapshot instead/);
    expect(builtin.campaignCount).toBe(1);
  });
});

// The production crash loop, end to end: an extension row already in the database collides
// with the campaign it extends, so the *first* build fails -- after every source has loaded,
// inside validation, where no source-level fallback can see it. Before `ready`'s fallback
// this exited the process before it bound a port, and the API that could delete the row was
// the API that never started. The recovery below is only possible because it boots.
describeIfDb("a stored source that cannot be merged", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      "truncate content_sources, badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
    // `end` is already a node on every `minimalPortableCampaign`, so applying this throws
    // inside `buildValidatedContentRegistry` rather than failing any source's load.
    await pool.query(
      `insert into content_sources (source_id, kind, label, payload)
       values ('00000000-0000-4000-8000-00000000c011', 'pasted', 'colliding-ext', $1)`,
      [
        JSON.stringify({
          formatVersion: 1,
          id: "colliding-ext",
          extends: "base-campaign",
          nodes: {
            end: {
              id: "end",
              kind: "ending",
              textKey: "x.end.text",
              endingId: "end",
            },
          },
          strings: { "x.end.text": "collides" },
        }),
      ],
    );

    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
      adminSubjects: [ADMIN_SUBJECT],
      campaignSource: createMultiSourceCampaignSource(pool, {
        id: "builtin-default",
        label: "builtin",
        kind: "url",
        url: "http://127.0.0.1:1/",
        fallback: {
          load: async () => ({
            campaigns: [
              minimalPortableCampaign(
                "base-campaign",
              ) as unknown as PortableCampaign,
            ],
            extensions: [],
          }),
        },
      }),
      bootstrapSource: {
        load: async () => ({
          campaigns: [
            minimalPortableCampaign(
              "snapshot-campaign",
            ) as unknown as PortableCampaign,
          ],
          extensions: [],
        }),
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("boots anyway, says it is on the snapshot, and lets an admin delete the row and recover", async () => {
    // Exactly the recovery an operator has through the admin page, with no psql involved.
    const cookie = cookieFrom(
      await app.inject({ method: "POST", url: "/api/admin/content/refresh" }),
    );
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const [provider, subject] = ADMIN_SUBJECT.split(":");
    await pool.query(
      `insert into identities (provider, subject, player_id) values ($1, $2, $3)`,
      [provider, subject, (me.json() as { playerId: string }).playerId],
    );

    const beforeFix = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie },
    });
    const before = beforeFix.json() as {
      status: { bootstrapFallback: boolean; lastError?: string };
      campaigns: { campaignId: string }[];
    };
    expect(before.status.bootstrapFallback).toBe(true);
    expect(before.status.lastError).toMatch(/already exists on campaign/);
    expect(before.campaigns.map((c) => c.campaignId)).toEqual([
      "snapshot-campaign",
    ]);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/admin/content/sources/00000000-0000-4000-8000-00000000c011",
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/admin/content/refresh",
      headers: { cookie },
    });
    expect(refreshed.json()).toEqual({ ok: true });

    const afterFix = await app.inject({
      method: "GET",
      url: "/api/admin/content/status",
      headers: { cookie },
    });
    const after = afterFix.json() as {
      status: { bootstrapFallback: boolean };
      campaigns: { campaignId: string }[];
    };
    expect(after.status.bootstrapFallback).toBe(false);
    expect(after.campaigns.map((c) => c.campaignId)).toEqual(["base-campaign"]);
  });
});
