/**
 * Permanent content deletion (engine plan 54, D3 §5-§7): the three-step protocol, the external
 * ledger that a restore cannot roll back, the reconciler that re-applies it, the tombstones a
 * purged row leaves its owner, the merge that carries them to the surviving account, and the
 * request log that names no id a deletion would have to chase.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import Fastify from "fastify";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import { answerNotFound, buildApp, requestLogSerializers } from "../app.js";
import { createServerDemo, type ServerDemo } from "../composition.js";
import type { CampaignSource } from "../campaigns/source.js";
import { addSubmission } from "../content-sources.js";
import { mergePlayers } from "../principal.js";
import { answerDeletion } from "../routes/content.js";
import { OwnershipError, ownedStore } from "../store/ownedStore.js";
import { ContentRefusal } from "./admission.js";
import { buildCandidate } from "./candidate.js";
import {
  deleteSource,
  grantTokenHash,
  reconcileDeletions,
} from "./deletion.js";
import { createMemoryLedger, createUnreachableLedger } from "./ledger.js";
import { resetContentEpochs } from "./reset.js";

const src = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

const relative = (path: string) =>
  path.slice(src.length).replace(/\\/g, "/").replace(/^\//, "");

describe("the deletion tables", () => {
  it("are written, and epochs and entries deleted, only by the protocol", () => {
    const writes =
      /(insert into|delete from)\s+(content_deletions|content_deletion_keys|content_deleted_campaigns|content_publication_entry_markers|session_tombstones|save_tombstones|grant_tombstones|run_tombstones)\b|delete from\s+(content_epochs|content_publication_entries)\b/i;
    const writers = sources(src)
      .filter((file) => writes.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(writers).toEqual(["content/deletion.ts"]);
  });
});

describe("grantTokenHash", () => {
  it("is a SHA-256 digest, never the token", () => {
    const token = randomUUID();
    const hash = grantTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(grantTokenHash(token)).toBe(hash);
  });
});

describe("the memory ledger", () => {
  const entry = (deletionId: string) => ({
    deletionId,
    sourceId: randomUUID(),
    keyHashes: ["a"],
    deletedAt: new Date(0).toISOString(),
    actorRole: "owner" as const,
    actorPlayerId: null,
  });

  it("appends once per deletion and answers what lies above a sequence", async () => {
    const ledger = createMemoryLedger();
    expect(await ledger.append(entry("d1"))).toBe(1);
    expect(await ledger.append(entry("d2"))).toBe(2);
    expect(await ledger.append(entry("d1"))).toBe(1);
    expect((await ledger.since(0)).map((e) => e.deletionId)).toEqual([
      "d1",
      "d2",
    ]);
    expect((await ledger.since(1)).map((e) => e.deletionId)).toEqual(["d2"]);
  });

  it("fails every call while unreachable", async () => {
    const ledger = createMemoryLedger();
    ledger.unreachable = true;
    await expect(ledger.append(entry("d1"))).rejects.toThrow(/unreachable/);
    await expect(ledger.since(0)).rejects.toThrow(/unreachable/);
  });

  it("is never what an unset LEDGER_DATABASE_URL gives", async () => {
    const ledger = createUnreachableLedger();
    await expect(ledger.since(0)).rejects.toThrow(/LEDGER_DATABASE_URL/);
    await expect(ledger.append(entry("d1"))).rejects.toThrow(
      /LEDGER_DATABASE_URL/,
    );
  });
});

describe("answerDeletion", () => {
  async function answer(outcome: "done" | "pending", days: number | undefined) {
    const app = Fastify();
    app.delete("/", async (_request, reply) =>
      answerDeletion(reply, outcome, days),
    );
    const response = await app.inject({ method: "DELETE", url: "/" });
    await app.close();
    return response;
  }

  it("answers a finished deletion 204, with the retention as a header", async () => {
    const response = await answer("done", 7);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["backup-retention-days"]).toBe("7");
  });

  it("answers a recorded but unfinished deletion 202 deletion_pending", async () => {
    const response = await answer("pending", 14);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      status: "deletion_pending",
      backupRetentionDays: 14,
    });
  });

  it("leaves the retention out where none is configured", async () => {
    const response = await answer("pending", undefined);
    expect(response.json()).toEqual({ status: "deletion_pending" });
    expect(response.headers["backup-retention-days"]).toBeUndefined();
  });
});

describe("the request log", () => {
  it("names the route pattern, never an id, matched or not", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        level: "info",
        serializers: requestLogSerializers,
        stream: { write: (line: string) => void lines.push(line) },
      },
    });
    app.setNotFoundHandler(answerNotFound);
    app.get("/api/sessions/:id", async () => ({ ok: true }));
    const id = randomUUID();
    expect(
      (await app.inject({ method: "GET", url: `/api/sessions/${id}` }))
        .statusCode,
    ).toBe(200);
    const missing = await app.inject({
      method: "GET",
      url: `/api/no-such-route/${id}`,
    });
    expect(missing.statusCode).toBe(404);
    // The 404 body is Fastify's own, for whoever sent the URL; only the log omits it.
    expect(missing.json()).toMatchObject({
      statusCode: 404,
      error: "Not Found",
    });
    await app.close();

    const log = lines.join("");
    expect(lines.length).toBeGreaterThan(0);
    expect(log).toContain("/api/sessions/:id");
    expect(log).not.toContain(id);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

function campaign(id: string) {
  return {
    formatVersion: 2,
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
  } as unknown as PortableCampaign;
}

function sourceOf(...campaigns: PortableCampaign[]): CampaignSource {
  return { load: async () => ({ campaigns, extensions: [] }) };
}

/** Settles `promise` to what it threw, or undefined. */
const thrown = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describeIfDb("deletion against Postgres", () => {
  let pool: Pool;
  let owner: string;
  let other: string;
  let sourceId: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate content_sources, badges, achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
    await resetContentEpochs(pool);
    owner = randomUUID();
    other = randomUUID();
    for (const id of [owner, other])
      await pool.query(
        "insert into players (player_id, kind) values ($1, 'guest')",
        [id],
      );
    sourceId = (
      await addSubmission(pool, owner, "mine", {
        kind: "pasted",
        payload: campaign("mine"),
      })
    ).id;
  });

  const as = (demo: ServerDemo, playerId: string) =>
    ownedStore(demo.store, pool, playerId, demo);

  /** Core `a`, plus `owner`'s private submission `mine`, published from `sourceId`. */
  async function published(): Promise<ServerDemo> {
    const demo = await createServerDemo(pool, sourceOf(campaign("a")));
    await demo.runtime.publish(
      buildCandidate(
        [campaign("a")],
        [],
        [{ sourceId, portable: campaign("mine") }],
        () => ({ ownerPlayerId: owner, visibility: "private" }),
      ),
    );
    return demo;
  }

  async function startMine(demo: ServerDemo): Promise<string> {
    const { sessionId } = await as(demo, owner).createSession({
      campaignId: "mine",
      audience: "player",
      profileId: owner,
    });
    return sessionId;
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from ${sql}`,
      params,
    );
    return rows[0]!.n;
  }

  const actor = () => ({ role: "owner" as const, playerId: owner });

  it("purges the session and the epoch, leaves a tombstone and a contentless ledger entry", async () => {
    const demo = await published();
    const sessionId = await startMine(demo);
    const ledger = createMemoryLedger();

    expect(await deleteSource(pool, ledger, sourceId, actor())).toBe("done");

    expect(await count("sessions where session_id = $1", [sessionId])).toBe(0);
    expect(
      await count(
        "session_tombstones where session_id = $1 and profile_id = $2",
        [sessionId, owner],
      ),
    ).toBe(1);
    expect(await count("content_epochs where campaign_id = 'mine'")).toBe(0);
    expect(await count("content_epochs where campaign_id = 'a'")).toBe(1);
    expect(
      await count("content_sources where source_id = $1", [sourceId]),
    ).toBe(0);
    expect(
      await count(
        "content_deletions where source_id = $1 and state = 'purged' and external_seq is not null",
        [sourceId],
      ),
    ).toBe(1);

    const entries = await ledger.since(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceId,
      actorRole: "owner",
      actorPlayerId: null,
    });
    expect(entries[0]!.keyHashes).toHaveLength(1);
    // Contentless: neither the campaign id nor anything it said.
    expect(JSON.stringify(entries)).not.toMatch(/mine|The end/);

    // The current publication no longer names it, so a new start finds nothing.
    const refused = await thrown(startMine(demo));
    expect(refused).toBeInstanceOf(ContentRefusal);
    expect((refused as ContentRefusal).code).toBe("unknown_campaign");
  });

  it("purges even when the ledger is unreachable, and the reconciler appends it later", async () => {
    const demo = await published();
    const sessionId = await startMine(demo);
    const ledger = createMemoryLedger();
    ledger.unreachable = true;

    expect(await deleteSource(pool, ledger, sourceId, actor())).toBe("pending");
    expect(await count("sessions where session_id = $1", [sessionId])).toBe(0);
    expect(
      await count(
        "content_deletions where state = 'purged' and external_seq is null",
      ),
    ).toBe(1);

    expect(await reconcileDeletions(pool, ledger)).toBe("failed");

    ledger.unreachable = false;
    expect(await reconcileDeletions(pool, ledger)).toBe("done");
    expect(await ledger.since(0)).toHaveLength(1);
    expect(await count("content_deletions where external_seq is null")).toBe(0);
  });

  it("deletes again what a restore from before the deletion brought back", async () => {
    const ledger = createMemoryLedger();
    await startMine(await published());
    expect(await deleteSource(pool, ledger, sourceId, actor())).toBe("done");
    const [entry] = await ledger.since(0);

    // A restore to before the deletion: the database has never heard of it, and the content
    // and a session on it are back. The external ledger is not restored with it.
    await resetContentEpochs(pool);
    const restored = await startMine(await published());
    expect(await count("content_deletions")).toBe(0);

    expect(await reconcileDeletions(pool, ledger)).toBe("done");
    expect(await count("sessions where session_id = $1", [restored])).toBe(0);
    expect(await count("content_epochs where campaign_id = 'mine'")).toBe(0);
    expect(
      await count(
        "content_deletions where deletion_id = $1 and state = 'purged'",
        [entry!.deletionId],
      ),
    ).toBe(1);
    // Applied once; a second pass has nothing left to do.
    expect(await reconcileDeletions(pool, ledger)).toBe("done");
    expect(await ledger.since(0)).toHaveLength(1);
  });

  it("answers a purged session 410 to its owner, 403 to anyone else, and 404 otherwise", async () => {
    const demo = await published();
    const sessionId = await startMine(demo);
    await deleteSource(pool, createMemoryLedger(), sourceId, actor());

    const own = await thrown(as(demo, owner).getView(sessionId));
    expect(own).toBeInstanceOf(ContentRefusal);
    expect((own as ContentRefusal).code).toBe("campaign_deleted");
    expect((own as ContentRefusal).status).toBe(410);

    expect(await thrown(as(demo, other).getView(sessionId))).toBeInstanceOf(
      OwnershipError,
    );

    const never = await thrown(as(demo, owner).getView(randomUUID()));
    expect(never).toBeDefined();
    expect(never).not.toBeInstanceOf(ContentRefusal);
    expect(never).not.toBeInstanceOf(OwnershipError);
  });

  it("carries tombstones and submissions to the account a guest merges into", async () => {
    const demo = await published();
    const sessionId = await startMine(demo);
    await deleteSource(pool, createMemoryLedger(), sourceId, actor());
    const kept = await addSubmission(pool, owner, "kept", {
      kind: "pasted",
      payload: campaign("kept"),
    });

    await mergePlayers(pool, owner, other);

    expect(await count("players where player_id = $1", [owner])).toBe(0);
    expect(
      await count(
        "session_tombstones where session_id = $1 and profile_id = $2",
        [sessionId, other],
      ),
    ).toBe(1);
    expect(
      await count(
        "content_sources where source_id = $1 and owner_player_id = $2",
        [kept.id, other],
      ),
    ).toBe(1);
    const own = await thrown(as(demo, other).getView(sessionId));
    expect((own as ContentRefusal).code).toBe("campaign_deleted");
  });
});

describeIfDb("DELETE /api/content/:id", () => {
  let pool: Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

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
      "truncate content_sources, badges, achievements, identities, auth_sessions, saves, sessions, players restart identity cascade",
    );
    await resetContentEpochs(pool);
  });

  it("deletes the owner's submission, and a second delete finds nothing", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { campaignId: "what-would-lucifer-do" },
    });
    const raw = started.headers["set-cookie"];
    const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie },
    });
    const { playerId } = me.json() as { playerId: string };
    const row = await addSubmission(pool, playerId, "mine", {
      kind: "pasted",
      payload: campaign("mine"),
    });

    const first = await app.inject({
      method: "DELETE",
      url: `/api/content/${row.id}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(204);

    const second = await app.inject({
      method: "DELETE",
      url: `/api/content/${row.id}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(404);
  });
});
