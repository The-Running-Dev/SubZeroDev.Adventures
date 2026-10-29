/**
 * Admission (engine plan 54, D4 §2-§3): the gate refuses a new start before the store is
 * called, the fence refuses a write the current publication no longer admits, and every route
 * that can mint a session at revision 0 or insert an offline grant is one the D4 table names.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  SessionStoreError,
  type ContentChannel,
  type PortableCampaign,
} from "@the-running-dev/game-engine";
import { createServerDemo, type ServerDemo } from "../composition.js";
import type { CampaignSource } from "../campaigns/source.js";
import { OwnershipError, ownedStore } from "../store/ownedStore.js";
import {
  admittingChannel,
  ContentRefusal,
  currentAdmission,
  D4_ENTRY_POINTS,
  lineageOf,
  runAdmitted,
} from "./admission.js";
import { buildCandidate } from "./candidate.js";
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

/** Every `app.<method>("<path>", ...)` registration in a route file, with its body: the text
 *  up to the next registration. */
function registrations(text: string) {
  const pattern = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  const found = [...text.matchAll(pattern)];
  return found.map((match, index) => ({
    route: `${match[1]!.toUpperCase()} ${match[2]}`,
    body: text.slice(match.index, found[index + 1]?.index ?? text.length),
  }));
}

describe("D4 §3 entry points", () => {
  const minting = /\.(createSession|branchSession|loadGame|download|sync)\(/;

  it("names every route that can mint a session or insert a grant", () => {
    const routes = sources(join(src, "routes")).flatMap((file) =>
      registrations(readFileSync(file, "utf8"))
        .filter((r) => minting.test(r.body))
        .map((r) => r.route),
    );
    expect(routes.sort()).toEqual(Object.keys(D4_ENTRY_POINTS).sort());
  });

  it("reaches the minting operations only through the gated decorators", () => {
    const raw =
      /\b(?!request\.)(\w+)\.store\.(createSession|branchSession|loadGame)\(|\bstore\.(createSession|branchSession|loadGame)\(/;
    const callers = sources(src)
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some((line) => raw.test(line) && !line.includes("request.store.")),
      )
      .map(relative)
      .sort();
    // `ownedStore` is the gate; `content/reset.ts` is the tests' admitted helper.
    expect(callers).toEqual(["content/reset.ts", "store/ownedStore.ts"]);
  });

  it("inserts a grant, a session or a save in one place each", () => {
    const writers = (sql: RegExp) =>
      sources(src)
        .filter((file) => sql.test(readFileSync(file, "utf8")))
        .map(relative);
    expect(writers(/insert into offline_grants/i)).toEqual([
      "offline/store.ts",
    ]);
    expect(writers(/insert into sessions\b/i)).toEqual(["persistence.ts"]);
    expect(writers(/insert into saves\b/i)).toEqual(["persistence.ts"]);
  });
});

describe("lineageOf", () => {
  const state = {
    campaignId: "a",
    campaignVersion: "3.0.0",
    actionLog: [
      { seq: 0, actionId: "go" },
      { seq: 1, system: "content", from: "1.0.0", to: "2.0.0" },
      { seq: 2, system: "migration", from: "2.0.0", to: "3.0.0" },
    ],
  };

  it("names the current version and both ends of every adoption and migration", () => {
    const lineage = lineageOf(JSON.stringify(state));
    expect(lineage.campaignId).toBe("a");
    expect(lineage.campaignVersion).toBe("3.0.0");
    expect([...lineage.versions].sort()).toEqual(["1.0.0", "2.0.0", "3.0.0"]);
  });

  it("reads a save envelope's state", () => {
    const lineage = lineageOf(JSON.stringify({ saveId: "s", state }));
    expect([...lineage.versions].sort()).toEqual(["1.0.0", "2.0.0", "3.0.0"]);
  });
});

describe("the admission", () => {
  it("rides through awaits and is gone outside", async () => {
    expect(currentAdmission()).toBeUndefined();
    const seen = await runAdmitted(
      {
        kind: "new",
        campaignId: "a",
        campaignVersion: "1.0.0",
        playerId: null,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return currentAdmission();
      },
    );
    expect(seen).toMatchObject({ kind: "new", campaignVersion: "1.0.0" });
    expect(currentAdmission()).toBeUndefined();
  });

  it("is what the channel offers a new start of its campaign, and only that", async () => {
    const channel = admittingChannel({
      current: () => "9.9.9",
    } as ContentChannel);
    const scope = (campaignId: string) => ({ campaignId, sessionId: "s" });
    expect(channel.current(scope("a"))).toBe("9.9.9");
    await runAdmitted(
      {
        kind: "new",
        campaignId: "a",
        campaignVersion: "1.0.0",
        playerId: null,
      },
      async () => {
        expect(channel.current(scope("a"))).toBe("1.0.0");
        expect(channel.current(scope("b"))).toBe("9.9.9");
      },
    );
    await runAdmitted(
      {
        kind: "derived",
        campaignId: "a",
        versions: new Set(["1.0.0"]),
        playerId: null,
      },
      async () => expect(channel.current(scope("a"))).toBe("9.9.9"),
    );
  });

  it("answers each refusal with its status", () => {
    expect(new ContentRefusal("x", "unknown_campaign").status).toBe(404);
    expect(new ContentRefusal("x", "forbidden").status).toBe(403);
    expect(new ContentRefusal("x", "campaign_access_revoked").status).toBe(403);
    expect(new ContentRefusal("x", "campaign_version_unsupported").status).toBe(
      409,
    );
    expect(new ContentRefusal("x", "campaign_version_unavailable").status).toBe(
      409,
    );
    expect(new ContentRefusal("x", "storage_failure").status).toBe(503);
  });
});

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
// `content_epoch_sources.source_id` is a uuid (migration 020), as every real `source_id` is.
const SOURCE_ID = "00000000-0000-4000-8000-000000000001";

function campaign(id: string, version = "1.0.0", endText = "The end.") {
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
      version,
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
      [`${id}.end.text`]: endText,
    },
  } as unknown as PortableCampaign;
}

function sourceOf(...campaigns: PortableCampaign[]): CampaignSource {
  return { load: async () => ({ campaigns, extensions: [] }) };
}

describeIfDb("admission against Postgres", () => {
  let pool: Pool;
  let owner: string;
  let other: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      "truncate badges, achievements, auth_sessions, saves, sessions, players restart identity cascade",
    );
    await resetContentEpochs(pool);
    owner = randomUUID();
    other = randomUUID();
    for (const id of [owner, other])
      await pool.query(
        "insert into players (player_id, kind) values ($1, 'guest')",
        [id],
      );
  });

  async function sessionCount(): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from sessions",
    );
    return rows[0]!.n;
  }

  const as = (demo: ServerDemo, playerId: string) =>
    ownedStore(demo.store, pool, playerId, demo);

  async function refusal(promise: Promise<unknown>) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ContentRefusal);
    return (error as ContentRefusal).code;
  }

  /** Core `a`, plus a submission `mine` owned by `owner` at `visibility`. */
  async function withSubmission(visibility: "private" | "public") {
    const demo = await createServerDemo(pool, sourceOf(campaign("a")));
    await demo.runtime.publish(
      buildCandidate(
        [campaign("a")],
        [],
        [{ sourceId: SOURCE_ID, portable: campaign("mine") }],
        () => ({ ownerPlayerId: owner, visibility }),
      ),
    );
    return demo;
  }

  it("starts a session on the version the publication offers", async () => {
    const demo = await createServerDemo(pool, sourceOf(campaign("a")));
    const { sessionId } = await as(demo, owner).createSession({
      campaignId: "a",
      audience: "player",
      profileId: owner,
    });
    const { rows } = await pool.query<{ campaign_version: string }>(
      "select campaign_version from sessions where session_id = $1",
      [sessionId],
    );
    expect(rows[0]!.campaign_version).toBe("1.0.0");
  });

  it("refuses an unknown campaign with 404 and writes nothing", async () => {
    const demo = await createServerDemo(pool, sourceOf(campaign("a")));
    expect(
      await refusal(
        as(demo, owner).createSession({
          campaignId: "no-such-campaign",
          audience: "player",
          profileId: owner,
        }),
      ),
    ).toBe("unknown_campaign");
    expect(await sessionCount()).toBe(0);
  });

  it("refuses someone else's private submission with 403 and writes nothing", async () => {
    const demo = await withSubmission("private");
    expect(
      await refusal(
        as(demo, other).createSession({
          campaignId: "mine",
          audience: "player",
          profileId: other,
        }),
      ),
    ).toBe("forbidden");
    expect(await sessionCount()).toBe(0);
    await as(demo, owner).createSession({
      campaignId: "mine",
      audience: "player",
      profileId: owner,
    });
    expect(await sessionCount()).toBe(1);
  });

  it("answers a session whose campaign was revoked from its player with campaign_access_revoked", async () => {
    const demo = await withSubmission("public");
    const { sessionId } = await as(demo, other).createSession({
      campaignId: "mine",
      audience: "player",
      profileId: other,
    });
    await demo.runtime.publish(
      buildCandidate(
        [campaign("a")],
        [],
        [{ sourceId: SOURCE_ID, portable: campaign("mine") }],
        () => ({ ownerPlayerId: owner, visibility: "private" }),
      ),
    );
    expect(await refusal(as(demo, other).getScene(sessionId))).toBe(
      "campaign_access_revoked",
    );
  });

  it("keeps a withdrawn campaign's session playable, and refuses a new start of it", async () => {
    const demo = await createServerDemo(
      pool,
      sourceOf(campaign("a"), campaign("b")),
    );
    const { sessionId } = await as(demo, owner).createSession({
      campaignId: "b",
      audience: "player",
      profileId: owner,
    });
    const after = await createServerDemo(pool, sourceOf(campaign("a")));
    expect(await as(after, owner).getScene(sessionId)).toBeDefined();
    expect(
      await refusal(
        as(after, owner).createSession({
          campaignId: "b",
          audience: "player",
          profileId: owner,
        }),
      ),
    ).toBe("unknown_campaign");
  });

  it("fences a revision-0 write with no admission, and one the publication has moved past", async () => {
    const demo = await createServerDemo(pool, sourceOf(campaign("a")));
    const conflict = async (run: () => Promise<unknown>) => {
      const error = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SessionStoreError);
      expect((error as SessionStoreError).code).toBe("concurrent_modification");
    };
    await conflict(() =>
      demo.store.createSession({ campaignId: "a", audience: "player" }),
    );
    await createServerDemo(pool, sourceOf(campaign("a", "2.0.0", "New.")));
    await conflict(() =>
      runAdmitted(
        {
          kind: "new",
          campaignId: "a",
          campaignVersion: "1.0.0",
          playerId: null,
        },
        () => demo.store.createSession({ campaignId: "a", audience: "player" }),
      ),
    );
    expect(await sessionCount()).toBe(0);
  });

  it("branches and loads under the source's own lineage", async () => {
    const demo = await createServerDemo(pool, sourceOf(campaign("a")));
    const store = as(demo, owner);
    const { sessionId } = await store.createSession({
      campaignId: "a",
      audience: "player",
      profileId: owner,
    });
    const save = await store.saveGame(sessionId);
    await createServerDemo(pool, sourceOf(campaign("a", "2.0.0", "New.")));
    expect((await store.branchSession(sessionId, 0)).sessionId).not.toBe(
      sessionId,
    );
    expect((await store.loadGame(save.saveId)).sessionId).toBeDefined();
    await expect(
      as(demo, other).branchSession(sessionId, 0),
    ).rejects.toBeInstanceOf(OwnershipError);
  });
});
