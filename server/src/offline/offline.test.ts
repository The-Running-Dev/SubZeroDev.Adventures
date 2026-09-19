import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { createDiskCampaignSource } from "../campaigns/source.js";
import { buildApp } from "../app.js";
import { validateBundle } from "../../../shared/offline/runtime.js";
import type {
  Download,
  SyncRequest,
} from "../../../shared/offline/protocol.js";
const databaseUrl = process.env.DATABASE_URL;
const campaign = "what-would-lucifer-do";
(databaseUrl ? describe : describe.skip)("authoritative offline replay", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let owner: string;
  let cookie: string;
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
    const identity = await member();
    owner = identity.id;
    cookie = identity.cookie;
  });
  async function member() {
    const id = randomUUID(),
      token = randomUUID();
    await pool.query(
      "insert into players(player_id,kind) values($1,'member')",
      [id],
    );
    await pool.query(
      "insert into auth_sessions(token_hash,player_id,expires_at) values($1,$2,now()+interval '1 day')",
      [createHash("sha256").update(token).digest("hex"), id],
    );
    return { id, cookie: `sza_session=${token}` };
  }
  async function download(sessionId?: string, headers = { cookie }) {
    const response = await app.inject({
      method: "POST",
      url: `/api/offline/download/${campaign}`,
      headers,
      payload: sessionId ? { sessionId } : {},
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Download;
  }
  function body(d: Download): SyncRequest {
    return {
      schema: 1,
      localRunId: randomUUID(),
      idempotencyKey: randomUUID(),
      grant: d.base,
      base: d.base,
      bundleId: d.bundle.id,
      runtimeId: d.bundle.runtimeId,
      engineVersion: d.bundle.engineVersion,
      kindVersion: d.bundle.kindVersion,
      inputs: d.checkpoint?.inputs ?? {
        gameId: randomUUID(),
        seed: "offline-replay",
        audience: "player",
      },
      actions: d.checkpoint?.actions ?? [{ seq: 0, actionId: "laugh" }],
    };
  }
  const sync = (payload: unknown, auth = cookie) =>
    app.inject({
      method: "POST",
      url: "/api/offline/sync",
      headers: { cookie: auth, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  it("replays original game identity and atomically deduplicates retries, including a lost response", async () => {
    const d = await download(),
      r = body(d);
    const before = (
      await app.inject({ method: "GET", url: "/api/stats" })
    ).json();
    const [a, b] = await Promise.all([sync(r), sync(r)]);
    expect(a.statusCode, a.body).toBe(200);
    expect(b.json()).toEqual(a.json());
    // Discard the first response and retry the unchanged persisted request.
    expect((await sync(r)).json()).toEqual(a.json());
    expect(a.json().blob).toBe(
      validateBundle(d.bundle).replay(d.bundle.portable, r.inputs, r.actions)
        .blob,
    );
    expect(JSON.parse(a.json().blob).gameId).toBe(r.inputs.gameId);
    expect(
      (await pool.query("select count(*)::int n from offline_runs")).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query("select count(*)::int n from offline_receipts")).rows[0]
        .n,
    ).toBe(1);
    expect(
      (await app.inject({ method: "GET", url: "/api/stats" })).json(),
    ).toEqual(before);
    for (const table of ["sessions", "saves", "achievements", "badges"])
      expect(
        (await pool.query(`select count(*)::int n from ${table}`)).rows[0].n,
      ).toBe(0);
  });
  it("rejects stale bases, divergent logs and reused keys with different requests", async () => {
    const d = await download(),
      r = body(d);
    const receipt = (await sync(r)).json();
    expect(
      (await sync({ ...r, idempotencyKey: randomUUID() })).json().error.code,
    ).toBe("lineage_conflict");
    expect((await sync({ ...r, actions: [] })).json().error.code).toBe(
      "idempotency_mismatch",
    );
    expect(
      (
        await sync({
          ...r,
          base: receipt.base,
          idempotencyKey: randomUUID(),
          actions: [],
        })
      ).json().error.code,
    ).toBe("lineage_conflict");
  });
  it("prepares a real checkpoint and detects source advancement including ABA", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: { campaignId: campaign, seed: "checkpoint" },
      })
    ).json();
    const d = await download(created.sessionId);
    expect(d.checkpoint?.inputs.gameId).toBe(created.scene.gameId);
    const r = body(d);
    r.actions = [{ seq: 0, actionId: "laugh" }];
    const result = await sync(r);
    expect(result.statusCode, result.body).toBe(200);
    // An update that leaves the exact blob unchanged must still invalidate the lineage.
    await pool.query("update sessions set blob=blob where session_id=$1", [
      created.sessionId,
    ]);
    const stale = await sync({
      ...r,
      base: result.json().base,
      idempotencyKey: randomUUID(),
    });
    expect(stale.json().error.code).toBe("lineage_conflict");
    expect(
      (
        await pool.query("select blob from sessions where session_id=$1", [
          created.sessionId,
        ])
      ).rows[0].blob,
    ).toBe(d.checkpoint?.blob);
    expect(
      (await pool.query("select count(*)::int n from offline_runs")).rows[0].n,
    ).toBe(1);
  });
  it("does not permit a different member, guest, or logged-out cookie to claim a run", async () => {
    const d = await download(),
      r = body(d);
    const other = await member();
    expect((await sync(r, other.cookie)).statusCode).toBe(403);
    expect((await sync(r, "")).json().error.code).toBe("member_required");
    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect((await sync(r)).json().error.code).toBe("member_required");
    const guest = await download(undefined, { cookie: "" });
    expect(guest.owner).toBeNull();
    expect((await sync(body(guest), other.cookie)).statusCode).toBe(403);
  });
  it("protects checkpoint ownership at the store boundary", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie },
        payload: { campaignId: campaign },
      })
    ).json();
    const other = await member();
    const response = await app.inject({
      method: "POST",
      url: `/api/offline/download/${campaign}`,
      headers: { cookie: other.cookie },
      payload: { sessionId: created.sessionId },
    });
    expect(response.statusCode).toBe(403);
  });
  it.each(["bundleId", "runtimeId", "engineVersion", "kindVersion"] as const)(
    "refuses changed %s",
    async (field) => {
      const r = body(await download());
      expect((await sync({ ...r, [field]: "changed" })).json().error.code).toBe(
        "incompatible_bundle",
      );
    },
  );
  it.each([
    { actions: [{ seq: 8, actionId: "laugh" }] },
    { actions: [{ seq: 0, actionId: "invented" }] },
    {
      actions: [
        { seq: 0, actionId: "laugh", params: { value: { nested: true } } },
      ],
    },
    { actions: "not-a-log" },
  ])("rejects malformed or tampered actions %j", async ({ actions }) => {
    const r = body(await download());
    expect((await sync({ ...r, actions })).json().error.code).toBe(
      "invalid_actions",
    );
    expect(
      (await pool.query("select count(*)::int n from offline_receipts")).rows[0]
        .n,
    ).toBe(0);
  });
  it("reports a missing historical runtime and retains the authoritative archive", async () => {
    const d = await download(),
      r = body(d);
    await pool.query(
      "update offline_grants set bundle=jsonb_set(bundle,'{runtimeId}','\"missing\"') where token=$1",
      [d.base],
    );
    r.runtimeId = "missing";
    expect((await sync(r)).json().error.code).toBe("unsupported_runtime");
  });
  it("replays its pinned bundle after the live catalog changes", async () => {
    const d = await download(),
      r = body(d);
    const content = await createDiskCampaignSource().load();
    const changed = structuredClone(content);
    const index = changed.campaigns.findIndex(
      (c) => c.campaign.id === campaign,
    );
    const target = changed.campaigns[index]!;
    const campaigns = [...changed.campaigns];
    campaigns[index] = {
      ...target,
      catalog: { ...target.catalog, title: `${target.catalog.title} updated` },
    };
    const nextApp = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
      campaignSource: { load: async () => ({ ...changed, campaigns }) },
    });
    try {
      const latest = await nextApp.inject({
        method: "POST",
        url: `/api/offline/download/${campaign}`,
        headers: { cookie },
        payload: {},
      });
      expect(latest.json().bundle.id).not.toBe(d.bundle.id);
      const replay = await nextApp.inject({
        method: "POST",
        url: "/api/offline/sync",
        headers: { cookie },
        payload: r,
      });
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().blob).toBe(
        validateBundle(d.bundle).replay(d.bundle.portable, r.inputs, r.actions)
          .blob,
      );
    } finally {
      await nextApp.close();
    }
  });
  it("rolls back the replay when receipt persistence fails", async () => {
    const r = body(await download());
    await pool.query(`create function reject_offline_receipt() returns trigger language plpgsql as $$ begin raise exception 'simulated write failure'; end $$;
      create trigger reject_offline_receipt before insert on offline_receipts for each row execute function reject_offline_receipt()`);
    try {
      expect((await sync(r)).statusCode).toBe(500);
      expect(
        (await pool.query("select count(*)::int n from offline_runs")).rows[0]
          .n,
      ).toBe(0);
      expect(
        (await pool.query("select count(*)::int n from offline_receipts"))
          .rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query(
        "drop trigger reject_offline_receipt on offline_receipts; drop function reject_offline_receipt()",
      );
    }
    expect((await sync(r)).statusCode).toBe(200);
  });
  it("returns the authoritative personal archive only to its owner", async () => {
    const d = await download(),
      r = body(d);
    const result = await sync(r);
    expect(result.statusCode, result.body).toBe(200);
    const archive = await app.inject({
      method: "GET",
      url: "/api/offline/archive",
      headers: { cookie },
    });
    expect(archive.json().runs[0].blob).toBe(result.json().blob);
    expect(
      (await pool.query("select owner_id from offline_runs")).rows[0].owner_id,
    ).toBe(owner);
  });
});
