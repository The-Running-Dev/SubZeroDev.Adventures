/**
 * Session capture (engine spec 08 §8, docs/session-capture.md): the stored fixture replays, a
 * refusal comes back typed and stores nothing, deletion reaches every capture, expiry hides and
 * then removes one, and nobody but the owner or an admin reads one. Same `buildApp` +
 * `app.inject` style as `admin.test.ts`.
 */
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { createInMemoryProfileStore } from "@the-running-dev/game-engine";
import {
  buildReplayOutcome,
  runReplayFixture,
} from "@the-running-dev/game-engine/authoring";
import { KINDS } from "../../../shared/campaign-registry.js";
import { buildApp } from "../app.js";
import { faultCapture, type StoredCapture } from "../captures/store.js";
import { createServerDemoFromCurrent } from "../composition.js";
import { resetContentEpochs } from "../content/reset.js";
import { sweepExpiredCaptures } from "../maintenance.js";
import { mergePlayers } from "../principal.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string")
    throw new Error("no Set-Cookie header in response");
  return value.split(";")[0]!;
}

describeIfDb("session captures", () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate session_captures, content_sources, badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
    await resetContentEpochs(pool);
    app = await buildApp(pool, {
      siteUrl: "http://localhost:5173",
      apiUrl: "http://localhost:8787",
    });
  });

  /** A guest with one played session: the cookie, the player and the session. */
  async function played() {
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { campaignId: "what-would-lucifer-do", seed: "capture-seed" },
    });
    expect(created.statusCode, created.body).toBe(200);
    const cookie = cookieFrom(created);
    const { sessionId } = created.json() as { sessionId: string };
    const acted = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/actions`,
      headers: { cookie },
      payload: { actionId: "laugh" },
    });
    expect(acted.statusCode, acted.body).toBe(200);
    const status = (acted.json() as { scene: { status: string } }).scene.status;
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    return { cookie, playerId, sessionId, status };
  }

  async function capture(cookie: string, sessionId: string) {
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/capture`,
      headers: { cookie },
      payload: { consent: true },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { captureId: string };
  }

  async function makeAdmin(playerId: string): Promise<void> {
    await pool.query(`update players set role = 'admin' where player_id = $1`, [
      playerId,
    ]);
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from ${sql}`,
      params,
    );
    return rows[0]!.n;
  }

  const errorOf = (response: { json(): unknown }) =>
    (response.json() as { error: { code: string } }).error.code;

  it("stores a fixture that replays to the session's own outcome", async () => {
    const { cookie, playerId, sessionId, status } = await played();
    const { captureId } = await capture(cookie, sessionId);

    const read = await app.inject({
      method: "GET",
      url: `/api/captures/${captureId}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    const stored = read.json() as StoredCapture;
    expect(stored).toMatchObject({
      captureId,
      playerId,
      sessionId,
      campaignId: "what-would-lucifer-do",
      trigger: "report",
    });
    const { fixture } = stored;
    expect(fixture.name).toBe(`capture-${captureId}`);
    // The mapping lives beside the fixture, never in it.
    expect(JSON.stringify(fixture)).not.toContain(playerId);
    expect(fixture.config.campaignId).toBe("what-would-lucifer-do");
    expect(fixture.submissions).toEqual([
      expect.objectContaining({ actionId: "laugh" }),
    ]);

    const demo = await createServerDemoFromCurrent(pool);
    const registry = demo.engine.content.resolve(
      fixture.config.campaignId,
      fixture.campaignVersion,
    );
    expect(registry).toBeDefined();
    const context = {
      engine: demo.engine,
      kinds: KINDS,
      registry: registry!,
      profiles: createInMemoryProfileStore(),
      profileId: "replay",
    };
    const replayed = await buildReplayOutcome(context, fixture);
    expect(replayed.kind).toBe("outcome");
    if (replayed.kind !== "outcome") return;
    expect(replayed.outcome.finalStatus).toBe(status);
    expect(replayed.outcome.acceptedActions).toBe(1);
    expect(
      (await runReplayFixture(context, fixture, replayed.outcome)).kind,
    ).toBe("match");
  });

  it("captures nothing without consent in the request", async () => {
    const { cookie, sessionId } = await played();
    for (const payload of [{}, { consent: "yes" }, { consent: false }]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/capture`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response)).toBe("consent_required");
    }
    expect(await count("session_captures")).toBe(0);
  });

  it("answers the engine's refusals as typed errors and stores nothing", async () => {
    const { cookie } = await played();
    for (const id of ["not-a-uuid", randomUUID()]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${id}/capture`,
        headers: { cookie },
        payload: { consent: true },
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(errorOf(response)).toBe("unknown_session");
    }
    expect(await count("session_captures")).toBe(0);
  });

  it("refuses to capture another player's session", async () => {
    const { sessionId } = await played();
    const { cookie: stranger } = await played();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/capture`,
      headers: { cookie: stranger },
      payload: { consent: true },
    });
    expect(response.statusCode).toBe(403);
    expect(await count("session_captures")).toBe(0);
  });

  it("refuses every capture route to a request with no account, and mints none", async () => {
    const { sessionId } = await played();
    const players = await count("players");
    for (const [method, url] of [
      ["POST", `/api/sessions/${sessionId}/capture`],
      ["GET", "/api/captures"],
      ["DELETE", "/api/captures"],
      ["GET", "/api/captures/consent"],
      ["GET", `/api/captures/${randomUUID()}`],
      ["GET", "/api/admin/captures"],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        payload: method === "POST" ? { consent: true } : undefined,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await count("players")).toBe(players);
  });

  it("lets only the owner or an admin read or delete a capture", async () => {
    const owner = await played();
    const { captureId } = await capture(owner.cookie, owner.sessionId);
    const stranger = await played();

    for (const method of ["GET", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/api/captures/${captureId}`,
        headers: { cookie: stranger.cookie },
      });
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain("submissions");
    }
    const listed = await app.inject({
      method: "GET",
      url: "/api/captures",
      headers: { cookie: stranger.cookie },
    });
    expect(listed.json()).toEqual({ captures: [] });
    const notAdmin = await app.inject({
      method: "GET",
      url: "/api/admin/captures",
      headers: { cookie: stranger.cookie },
    });
    expect(notAdmin.statusCode).toBe(403);

    await makeAdmin(stranger.playerId);
    const adminRead = await app.inject({
      method: "GET",
      url: `/api/captures/${captureId}`,
      headers: { cookie: stranger.cookie },
    });
    expect(adminRead.statusCode).toBe(200);
    const adminList = await app.inject({
      method: "GET",
      url: "/api/admin/captures",
      headers: { cookie: stranger.cookie },
    });
    const { captures } = adminList.json() as {
      captures: { captureId: string }[];
    };
    expect(captures.map((c) => c.captureId)).toEqual([captureId]);
    // Summaries only: a listing never carries the fixture.
    expect(adminList.body).not.toContain("submissions");
  });

  it("lets an admin capture a player's session on their report, owned by that player", async () => {
    const player = await played();
    const admin = await played();
    await makeAdmin(admin.playerId);

    const missingConsent = await app.inject({
      method: "POST",
      url: "/api/admin/captures",
      headers: { cookie: admin.cookie },
      payload: { sessionId: player.sessionId },
    });
    expect(missingConsent.statusCode).toBe(400);
    expect(errorOf(missingConsent)).toBe("consent_required");

    const taken = await app.inject({
      method: "POST",
      url: "/api/admin/captures",
      headers: { cookie: admin.cookie },
      payload: { sessionId: player.sessionId, consent: true },
    });
    expect(taken.statusCode, taken.body).toBe(201);
    expect(taken.json()).toMatchObject({ playerId: player.playerId });

    const refused = await app.inject({
      method: "POST",
      url: "/api/admin/captures",
      headers: { cookie: player.cookie },
      payload: { sessionId: player.sessionId, consent: true },
    });
    expect(refused.statusCode).toBe(403);
  });

  it("deletes one capture, or all of the caller's, on request", async () => {
    const { cookie, sessionId } = await played();
    const first = await capture(cookie, sessionId);
    await capture(cookie, sessionId);
    const other = await played();
    await capture(other.cookie, other.sessionId);

    const one = await app.inject({
      method: "DELETE",
      url: `/api/captures/${first.captureId}`,
      headers: { cookie },
    });
    expect(one.statusCode).toBe(204);
    const gone = await app.inject({
      method: "GET",
      url: `/api/captures/${first.captureId}`,
      headers: { cookie },
    });
    expect(gone.statusCode).toBe(404);
    expect(errorOf(gone)).toBe("unknown_capture");

    const all = await app.inject({
      method: "DELETE",
      url: "/api/captures",
      headers: { cookie },
    });
    expect(all.json()).toEqual({ deleted: 1 });
    // The other player's capture is untouched.
    expect(await count("session_captures")).toBe(1);
  });

  it("deletes a player's captures with the account", async () => {
    const { cookie, playerId, sessionId } = await played();
    await capture(cookie, sessionId);
    await pool.query("delete from sessions where profile_id = $1", [playerId]);
    await pool.query("delete from players where player_id = $1", [playerId]);
    expect(await count("session_captures")).toBe(0);
  });

  it("carries a guest's captures to the surviving account on a merge", async () => {
    const { cookie, playerId, sessionId } = await played();
    const { captureId } = await capture(cookie, sessionId);
    const survivor = randomUUID();
    await pool.query(
      "insert into players (player_id, kind) values ($1, 'guest')",
      [survivor],
    );

    await mergePlayers(pool, playerId, survivor);

    expect(
      await count("session_captures where capture_id = $1 and player_id = $2", [
        captureId,
        survivor,
      ]),
    ).toBe(1);
  });

  it("hides an expired capture at once, and the sweep deletes it", async () => {
    const { cookie, sessionId } = await played();
    const { captureId } = await capture(cookie, sessionId);
    const kept = await capture(cookie, sessionId);
    await pool.query(
      "update session_captures set expires_at = now() - interval '1 second' where capture_id = $1",
      [captureId],
    );

    const read = await app.inject({
      method: "GET",
      url: `/api/captures/${captureId}`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(404);
    const listed = await app.inject({
      method: "GET",
      url: "/api/captures",
      headers: { cookie },
    });
    const { captures } = listed.json() as {
      captures: { captureId: string }[];
    };
    expect(captures.map((c) => c.captureId)).toEqual([kept.captureId]);

    expect(await sweepExpiredCaptures(pool)).toBe(1);
    expect(await count("session_captures")).toBe(1);
  });

  it("records fault-capture consent with a timestamp, off by default", async () => {
    const { cookie } = await played();
    const consent = () =>
      app
        .inject({
          method: "GET",
          url: "/api/captures/consent",
          headers: { cookie },
        })
        .then(
          (r) => r.json() as { faultCapture: boolean; consentedAt: string },
        );
    const set = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/api/captures/consent",
        headers: { cookie },
        payload: payload as object,
      });

    expect(await consent()).toEqual({ faultCapture: false, consentedAt: null });
    const invalid = await set({ faultCapture: "yes" });
    expect(invalid.statusCode).toBe(400);
    expect(errorOf(invalid)).toBe("invalid_body");

    const granted = (await set({ faultCapture: true })).json() as {
      faultCapture: boolean;
      consentedAt: string;
    };
    expect(granted.faultCapture).toBe(true);
    expect(Date.parse(granted.consentedAt)).not.toBeNaN();
    // Granting again keeps when it was first given.
    expect((await set({ faultCapture: true })).json()).toEqual(granted);

    expect((await set({ faultCapture: false })).json()).toEqual({
      faultCapture: false,
      consentedAt: null,
    });
  });

  it("captures a faulting session once, and only with its owner's consent", async () => {
    const { playerId, sessionId } = await played();
    const demo = await createServerDemoFromCurrent(pool);
    const warnings: string[] = [];
    const onFault = faultCapture(pool, 30, (message) => warnings.push(message));

    await onFault(demo.store, sessionId);
    expect(await count("session_captures")).toBe(0);

    await pool.query(
      "update players set fault_capture_consented_at = now() where player_id = $1",
      [playerId],
    );
    await onFault(demo.store, sessionId);
    await onFault(demo.store, sessionId);
    expect(
      await count(
        "session_captures where session_id = $1 and trigger = 'fault' and player_id = $2",
        [sessionId, playerId],
      ),
    ).toBe(1);

    // A session nobody owns is no capture and no warning.
    await onFault(demo.store, randomUUID());
    expect(warnings).toEqual([]);
  });
});
