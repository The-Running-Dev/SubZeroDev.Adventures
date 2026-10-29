/**
 * The durable half of content epochs (engine plan 54, §3.1-§3.4) against Postgres: a refresh
 * adds a publication rather than replacing content, a restart serves what is current without
 * reading a source, an identical refresh adds nothing, a key is forever, and the channel offers
 * a submission only to whoever may reach it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import {
  createServerDemo,
  createServerDemoFromCurrent,
} from "../composition.js";
import type { CampaignSource } from "../campaigns/source.js";
import { buildCandidate } from "./candidate.js";
import { createAdmitted, resetContentEpochs } from "./reset.js";
import { createContentRuntime, forgetContentRuntime } from "./runtime.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

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

const core = (...campaigns: PortableCampaign[]) =>
  buildCandidate(campaigns, [], [], () => {
    throw new Error("no submissions here");
  });

describeIfDb("content epochs", () => {
  let pool: Pool;

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
  });

  async function publicationCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      "select count(*) from content_publications",
    );
    return Number(rows[0]!.count);
  }

  it("hydrates what is current into a fresh process", async () => {
    const first = createContentRuntime(pool);
    const view = await first.publish(core(campaign("a"), campaign("b")));
    expect(view.entries.map((e) => e.campaignId)).toEqual(["a", "b"]);

    const restarted = createContentRuntime(pool);
    await restarted.ready();
    const hydrated = restarted.view()!;
    expect(hydrated.publicationId).toBe(view.publicationId);
    expect(
      hydrated.entries.map((e) => [e.campaignId, e.epoch.stored.digest]),
    ).toEqual(view.entries.map((e) => [e.campaignId, e.epoch.stored.digest]));
    expect(restarted.archive.resolve("a", "1.0.0")).toBeDefined();
  });

  it("adds no publication for a refresh that offers exactly what is current", async () => {
    const runtime = createContentRuntime(pool);
    const once = await runtime.publish(core(campaign("a")));
    const twice = await runtime.publish(core(campaign("a")));
    expect(twice.publicationId).toBe(once.publicationId);
    expect(await publicationCount()).toBe(1);
  });

  it("keeps a superseded epoch resolvable, here and after a restart", async () => {
    const runtime = createContentRuntime(pool);
    await runtime.publish(core(campaign("a", "1.0.0")));
    const next = await runtime.publish(
      core(campaign("a", "2.0.0", "A new end.")),
    );
    expect(next.entries.map((e) => e.campaignVersion)).toEqual(["2.0.0"]);
    expect(await publicationCount()).toBe(2);
    expect(runtime.archive.resolve("a", "1.0.0")).toBeDefined();

    const restarted = createContentRuntime(pool);
    await restarted.ready();
    expect(restarted.archive.resolve("a", "1.0.0")).toBeDefined();
    expect(restarted.view()!.entries.map((e) => e.campaignVersion)).toEqual([
      "2.0.0",
    ]);
  });

  it("refuses different content under a key it holds, and keeps serving", async () => {
    const runtime = createContentRuntime(pool);
    const first = await runtime.publish(core(campaign("a")));
    await expect(
      runtime.publish(core(campaign("a", "1.0.0", "Edited in place."))),
    ).rejects.toThrow(/content_version_conflict/);
    expect(await publicationCount()).toBe(1);
    expect(runtime.view()!.publicationId).toBe(first.publicationId);
    // Not stranded: a real change still publishes.
    await runtime.publish(core(campaign("a", "2.0.0")));
    expect(await publicationCount()).toBe(2);
  });

  it("refuses at the commit a key another process published first", async () => {
    const a = createContentRuntime(pool);
    const b = createContentRuntime(pool);
    await a.ready();
    await b.ready();
    await a.publish(core(campaign("a")));
    // `b` hydrated before `a` published, so neither its archive nor a held check could see
    // the key: the commit is what refuses it.
    await expect(
      b.publish(core(campaign("a", "1.0.0", "Edited in place."))),
    ).rejects.toThrow(/content_version_conflict/);
    expect(await publicationCount()).toBe(1);
  });

  it("re-reads and retries once when another process published first", async () => {
    const a = createContentRuntime(pool);
    const b = createContentRuntime(pool);
    await a.ready();
    await b.ready();
    await a.publish(core(campaign("a")));
    const won = await b.publish(core(campaign("a"), campaign("b")));
    expect(won.entries.map((e) => e.campaignId)).toEqual(["a", "b"]);
    expect(await publicationCount()).toBe(2);
  });

  it("offers a private submission only to its owner, and core to anyone", async () => {
    const runtime = createContentRuntime(pool);
    await runtime.publish(
      buildCandidate(
        [campaign("core-a")],
        [],
        [{ sourceId: "s1", portable: campaign("mine") }],
        () => ({ ownerPlayerId: "owner", visibility: "private" }),
      ),
    );
    const offer = (campaignId: string, profileId?: string) =>
      runtime.channel.current({
        campaignId,
        sessionId: "s",
        ...(profileId === undefined ? {} : { profileId }),
      });
    expect(offer("core-a")).toBe("1.0.0");
    expect(offer("mine", "owner")).toBe("1.0.0");
    expect(offer("mine", "someone-else")).toBeUndefined();
    expect(offer("mine")).toBeUndefined();
    expect(offer("no-such-campaign")).toBeUndefined();
  });

  it("boots on what is current with no source read, and keeps a session on a superseded epoch playable", async () => {
    const before = await createServerDemo(pool, sourceOf(campaign("a")));
    const { sessionId } = await createAdmitted(before, {
      campaignId: "a",
      audience: "player",
    });

    await createServerDemo(
      pool,
      sourceOf(campaign("a", "2.0.0", "A new end.")),
    );
    forgetContentRuntime(pool);
    const after = await createServerDemoFromCurrent(pool);
    expect(after.all.map((c) => c.campaignId)).toEqual(["a"]);

    const scene = await after.store.getScene(sessionId);
    expect(scene).toBeDefined();
    expect((await after.store.getView(sessionId)).status).toBe("active");

    const created = await createAdmitted(after, {
      campaignId: "a",
      audience: "player",
    });
    const { rows } = await pool.query<{ campaign_version: string }>(
      "select campaign_version from sessions where session_id = $1",
      [created.sessionId],
    );
    expect(rows[0]!.campaign_version).toBe("2.0.0");
  });

  it("refuses to boot from nothing when no publication is current", async () => {
    await expect(createServerDemoFromCurrent(pool)).rejects.toThrow(
      /no content publication is current/,
    );
  });
});
