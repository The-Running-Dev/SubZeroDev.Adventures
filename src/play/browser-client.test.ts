import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildBulgariaBureaucracyCampaign,
  buildBulgariaDrivingCampaign,
  buildBulgariaEnterpriseCampaign,
  buildBulgariaInheritanceCampaign,
  buildBulgariaReturnCampaign,
  buildValidatedContentRegistry,
  buildLuciferChroniclesCampaign,
  createCountingIds,
  createEngine,
  createInMemorySessionStore,
  storyGraphKind,
  TextClient,
  type ActionParams,
  type ContentRegistry,
  type CreateSessionConfig,
  type Engine,
  type KindRegistry,
} from "@the-running-dev/game-engine";
import type { BrowserDemo } from "./composition";
import { BrowserClient } from "./browser-client";
import { createBrowserDemo } from "./composition";
import manifestJson from "../../public/campaigns/manifest.json";
import whatWouldLuciferDoJson from "../../public/campaigns/what-would-lucifer-do.json";
import whatWouldLuciferDoEngineersCutJson from "../../public/campaigns/what-would-lucifer-do-engineers-cut.json";
import luciferChroniclesJson from "../../public/campaigns/lucifer-chronicles.json";
import bulgariaBureaucracyJson from "../../public/campaigns/bulgaria-bureaucracy.json";
import bulgariaReturnJson from "../../public/campaigns/bulgaria-return.json";
import bulgariaDrivingJson from "../../public/campaigns/bulgaria-driving.json";
import bulgariaInheritanceJson from "../../public/campaigns/bulgaria-inheritance.json";
import bulgariaEnterpriseJson from "../../public/campaigns/bulgaria-enterprise.json";
import sakiQuestJson from "../../public/campaigns/saki-quest-for-redemption.json";

const SEED = "bureaucracy-seed-3";

// SPIKE: `createBrowserDemo` now fetches runtime campaign JSON instead of importing a
// compiled-in build. jsdom has no server to fetch from, so `fetch` is stubbed here to
// return the exact files `npm run spike:export` wrote (statically imported, not a
// hand-built fixture) — proving the exported files validate through the real registry
// gate, not just that the pipeline runs. See plans/spike-notes.md.
const exportedCampaigns: Readonly<Record<string, unknown>> = {
  "manifest.json": manifestJson,
  "what-would-lucifer-do.json": whatWouldLuciferDoJson,
  "what-would-lucifer-do-engineers-cut.json":
    whatWouldLuciferDoEngineersCutJson,
  "lucifer-chronicles.json": luciferChroniclesJson,
  "bulgaria-bureaucracy.json": bulgariaBureaucracyJson,
  "bulgaria-return.json": bulgariaReturnJson,
  "bulgaria-driving.json": bulgariaDrivingJson,
  "bulgaria-inheritance.json": bulgariaInheritanceJson,
  "bulgaria-enterprise.json": bulgariaEnterpriseJson,
  "saki-quest-for-redemption.json": sakiQuestJson,
};
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const fileName = url.split("/campaigns/")[1];
    const body = fileName ? exportedCampaigns[fileName] : undefined;
    if (body === undefined) throw new Error(`Unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function makeBrowserClient(): Promise<BrowserClient> {
  return new BrowserClient((await createBrowserDemo()).store);
}

function recordStoreCalls(store: BrowserDemo["store"]): {
  store: BrowserDemo["store"];
  created: CreateSessionConfig[];
  submitted: ActionParams[];
  previewed: ActionParams[];
} {
  const created: CreateSessionConfig[] = [];
  const submitted: ActionParams[] = [];
  const previewed: ActionParams[] = [];
  return {
    store: {
      listCampaigns: () => store.listCampaigns(),
      getScene: (sessionId) => store.getScene(sessionId),
      getView: (sessionId) => store.getView(sessionId),
      getStrings: (sessionId) => store.getStrings(sessionId),
      createSession: (config) => {
        created.push(config);
        return store.createSession(config);
      },
      resumeSession: (sessionId) => store.resumeSession(sessionId),
      submitAction: (sessionId, actionId, params) => {
        if (params !== undefined) submitted.push(params);
        return store.submitAction(sessionId, actionId, params);
      },
      previewAction: (sessionId, actionId, params) => {
        if (params !== undefined) previewed.push(params);
        return store.previewAction(sessionId, actionId, params);
      },
      saveGame: (sessionId) => store.saveGame(sessionId),
      loadGame: (saveId) => store.loadGame(saveId),
    },
    created,
    submitted,
    previewed,
  };
}

function observeSerializations(engine: Engine): {
  engine: Engine;
  lastSerialized(): string | undefined;
} {
  const observer: { value?: string } = {};
  function wrap(current: Engine): Engine {
    return {
      kinds: current.kinds,
      createGame: (config) => current.createGame(config),
      scene: (state) => current.scene(state),
      view: (state, audience) => current.view(state, audience),
      availableActions: (state) => current.availableActions(state),
      submitAction: (state, actionId, params) =>
        current.submitAction(state, actionId, params),
      previewAction: (state, actionId, params) =>
        current.previewAction(state, actionId, params),
      serialize: (state) => {
        observer.value = current.serialize(state);
        return observer.value;
      },
      deserialize: (data) => current.deserialize(data),
      migrate: (data) => current.migrate(data),
      withEmitter: (emitter) => wrap(current.withEmitter(emitter)),
    };
  }
  return { engine: wrap(engine), lastSerialized: () => observer.value };
}

function makeParityFixture(): {
  client: TextClient;
  engine: Engine;
  registry: ContentRegistry;
  lastSerialized(): string | undefined;
} {
  const built = [
    buildBulgariaBureaucracyCampaign(),
    buildBulgariaDrivingCampaign(),
    buildBulgariaEnterpriseCampaign(),
    buildBulgariaInheritanceCampaign(),
    buildBulgariaReturnCampaign(),
    buildLuciferChroniclesCampaign(),
  ];
  if (built.some((campaign) => !campaign.ok || campaign.value === undefined)) {
    throw new Error("expected the story campaigns to build");
  }
  const kinds = { "story-graph": storyGraphKind } as unknown as KindRegistry;
  const registryResult = buildValidatedContentRegistry(
    built.map((campaign) => campaign.value!),
    kinds,
  );
  if (!registryResult.ok || registryResult.value === undefined) {
    throw new Error("expected the Bureaucracy campaign to validate");
  }
  const registry: ContentRegistry = registryResult.value;
  const observed = observeSerializations(
    createEngine({ kinds, registry, ids: createCountingIds() }),
  );
  return {
    client: new TextClient(
      createInMemorySessionStore({ engine: observed.engine, registry }),
    ),
    engine: observed.engine,
    registry,
    lastSerialized: observed.lastSerialized,
  };
}

const STORY_CAMPAIGN_IDS = [
  "bulgaria-bureaucracy",
  "bulgaria-driving",
  "bulgaria-enterprise",
  "bulgaria-inheritance",
  "bulgaria-return",
  "lucifer-chronicles",
] as const;

describe("BrowserClient — the API coverage checklist (09-clients.md §4, W61.8)", () => {
  it("1. listCampaigns — returns the configured Bureaucracy campaign", async () => {
    expect((await makeBrowserClient()).listCampaigns()).toContainEqual(
      expect.objectContaining({ campaignId: "bulgaria-bureaucracy" }),
    );
  });

  it("2. createSession — starts the Bureaucracy arc through the adapter", async () => {
    const started = await (
      await makeBrowserClient()
    ).createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    expect(started.scene.body.text).toContain("handwritten");
  });

  it("createSession — fixes the demo audience to player", async () => {
    const calls = recordStoreCalls((await createBrowserDemo()).store);
    const client = new BrowserClient(calls.store);
    await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
      // Simulates an untyped JavaScript caller; BrowserSessionConfig rejects this in TypeScript.
      ...({ audience: "ai" } as object),
    });
    expect(calls.created).toEqual([
      { campaignId: "bulgaria-bureaucracy", seed: SEED, audience: "player" },
    ]);
  });

  it("3. resumeSession — returns the current scene without changing it", async () => {
    const client = await makeBrowserClient();
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    expect((await client.resumeSession(started.sessionId)).scene).toEqual(
      started.scene,
    );
  });

  it("4. getScene — returns the scene created for the same session", async () => {
    const client = await makeBrowserClient();
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    expect(await client.getScene(started.sessionId)).toEqual(started.scene);
  });

  it("5. getView — returns the real StoryGraph player projection", async () => {
    const client = await makeBrowserClient();
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    expect(await client.getView(started.sessionId)).toEqual(started.view);
  });

  it("6. getStrings — resolves the Bureaucracy action label", async () => {
    const client = await makeBrowserClient();
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    await expect(client.getStrings(started.sessionId)).resolves.toMatchObject({
      "bureaucracy.municipality.choice_wait": "Wait for the municipal registry",
    });
  });

  it("7. submitAction — enters a materially separate route through the adapter", async () => {
    const client = await makeBrowserClient();
    let state = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    state = (await client.submit(state, "wait")).state;
    expect(state.actions).toContainEqual(
      expect.objectContaining({ id: "registry_route_listen", available: true }),
    );
  });

  it("8. previewAction — returns a prospective scene without changing the session", async () => {
    const client = await makeBrowserClient();
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    const preview = await client.previewAction(started.sessionId, "wait");
    expect(preview.scene?.body.text).toContain("quietly circles");
    expect(await client.getScene(started.sessionId)).toEqual(started.scene);
  });

  it("action helpers — forward declared parameters unchanged", async () => {
    const calls = recordStoreCalls((await createBrowserDemo()).store);
    const client = new BrowserClient(calls.store);
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    const params = { declared: "value" };
    await client.previewAction(started.sessionId, "wait", params);
    await client.submitAction(started.sessionId, "wait", params);
    expect(calls.previewed).toEqual([params]);
    expect(calls.submitted).toEqual([params]);
  });

  it("9. saveGame — creates a same-page checkpoint", async () => {
    const client = await makeBrowserClient();
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    await expect(client.saveGame(started.sessionId)).resolves.toMatchObject({
      savedAtSeq: 0,
    });
  });

  it("10. loadGame — restores a fresh session at the checkpoint scene", async () => {
    const client = await makeBrowserClient();
    const started = await client.createSession({
      campaignId: "bulgaria-bureaucracy",
      seed: SEED,
    });
    const checkpoint = await client.saveGame(started.sessionId);
    const restored = await client.loadGame(checkpoint.saveId);
    expect(restored.sessionId).not.toBe(started.sessionId);
    expect(restored.scene).toEqual(started.scene);
  });
});

describe("BrowserClient — story-campaign client parity (09-clients.md §1, W64.8)", () => {
  it.each(STORY_CAMPAIGN_IDS)(
    "%s: the browser adapter and text client produce identical route scenes, views, and final serializations",
    async (campaignId) => {
      const browserFixture = makeParityFixture();
      const browser = new BrowserClient(
        createInMemorySessionStore({
          engine: browserFixture.engine,
          registry: browserFixture.registry,
        }),
      );
      const textFixture = makeParityFixture();
      const text = textFixture.client;

      const browserStarted = await browser.createSession({
        campaignId,
        seed: SEED,
      });
      const textStarted = await text.createSession({
        campaignId,
        seed: SEED,
      });
      let browserState = browserStarted;
      const textSessionId = textStarted.value.sessionId;
      expect(browserState.scene).toEqual(textStarted.value.scene);
      expect(browserState.view).toEqual(
        await text.getView(textSessionId).then((value) => value.value),
      );

      while (browserState.scene.status !== "ended") {
        const actionId = browserState.actions.find(
          (action) => action.available,
        )?.id;
        if (!actionId) throw new Error("expected an available route action");
        browserState = (await browser.submit(browserState, actionId)).state;
        const textResult = await text.submitAction(textSessionId, actionId);
        expect(browserState.scene).toEqual(textResult.value.scene);
        expect(browserState.view).toEqual(
          (await text.getView(textSessionId)).value,
        );
      }

      expect(browserState.scene.status).toBe("ended");
      expect(browserFixture.lastSerialized()).toBe(
        textFixture.lastSerialized(),
      );
    },
  );
});
