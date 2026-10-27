/** Real PostgreSQL consumer boundary: engine-only persistence maps cannot catch a
 * host dropping initialization, or confusing legacy SQL NULL with recorded JSON {}. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createEngine,
  createInMemoryProfileStore,
  createInMemorySessionStore,
  SESSION_PERSISTENCE_CONFLICT,
  type ContentRegistry,
  type Kind,
  type KindRegistry,
  type SessionInitialization,
  type StoredSaveRecord,
  type StoredSessionRecord,
} from "@the-running-dev/game-engine";
import { createPostgresPersistence } from "./persistence.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const timestamp = "2026-10-27T00:00:00.000Z";

interface SeededState {
  count: number;
  seeded: unknown;
}

// Test-only kind: the profile input is observable in both authoritative state and view.
// It uses the supported Kind seam, without changing any product campaign or golden.
const kind: Kind<SeededState> = {
  id: "story-graph",
  version: "1.0.0",
  reasonCodes: [],
  reasonMessages: new Map(),
  eventNames: [],
  initialState: (_campaign, _ctx, seed) => ({
    state: { count: 0, seeded: seed ?? null },
    status: "active",
    changes: [],
    messages: [],
  }),
  availableActions: () => [
    { id: "bump", labelKey: "test.bump", available: true },
  ],
  advance: (state) => ({
    state: { ...state, count: state.count + 1 },
    status: "active",
    changes: [],
    messages: [],
  }),
  scene: (state) => ({ textKey: "test.scene", text: JSON.stringify(state) }),
  project: (state) => state,
  validateCampaign: () => ({ ok: true, errors: [], warnings: [] }),
  validateState: () => true,
  outcome: () => ({ terminal: false, terminalId: null }),
  profileData: { version: 1, fold: (current) => current },
};
const kinds = { "story-graph": kind } as unknown as KindRegistry;
const registry: ContentRegistry = {
  campaigns: new Map([
    [
      "test",
      {
        id: "test",
        kindId: "story-graph",
        version: "1",
        titleKey: "test.title",
        content: {},
      },
    ],
  ]),
  strings: new Map([
    ["test.title", "Test"],
    ["test.scene", "Scene"],
    ["test.bump", "Bump"],
  ]),
};

describeIfDb("Postgres initialization persistence", () => {
  let pool: Pool;
  let profileId: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("truncate players cascade");
    profileId = randomUUID();
    await pool.query(
      "insert into players (player_id, kind) values ($1, 'guest')",
      [profileId],
    );
  });

  function sessionRecord(
    initialization?: SessionInitialization,
  ): StoredSessionRecord {
    return {
      sessionId: randomUUID(),
      blob: JSON.stringify({
        campaignId: "test",
        status: "active",
        kindId: "story-graph",
        kindState: {},
        actionLog: [],
      }),
      audience: "player",
      attemptCounter: 0,
      revision: 0,
      replayCompatible: true,
      profileId,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(initialization === undefined ? {} : { initialization }),
    };
  }

  it.each([
    ["missing legacy wrapper", undefined],
    ["explicit no-profile initialization", {}],
    [
      "nested profile initialization",
      {
        kindProfileData: {
          boost: 7,
          nested: { flags: [true, false], value: null },
        },
      },
    ],
  ] as const)(
    "round-trips %s through sessions, saves and save listing",
    async (_label, initialization) => {
      const persistence = createPostgresPersistence(pool, kinds);
      const session = sessionRecord(initialization);
      const save: StoredSaveRecord = {
        saveId: randomUUID(),
        campaignId: "test",
        blob: session.blob,
        savedAt: timestamp,
        savedAtSeq: 0,
        audience: "player",
        profileId,
        ...(initialization === undefined ? {} : { initialization }),
      };
      await persistence.sessions.put(session);
      await persistence.saves.put(save);
      const cold = createPostgresPersistence(pool, kinds);
      expect(await cold.sessions.get(session.sessionId)).toStrictEqual(session);
      expect(await cold.saves.get(save.saveId)).toStrictEqual(save);
      expect(await cold.saves.listByProfile(profileId)).toStrictEqual([save]);
      expect(
        (
          await pool.query(
            "select initialization is null as legacy from sessions where session_id = $1",
            [session.sessionId],
          )
        ).rows[0].legacy,
      ).toBe(initialization === undefined);
    },
  );

  it("updates initialization in both upserts, preserves CAS, and can clear back to legacy", async () => {
    const persistence = createPostgresPersistence(pool, kinds);
    let session = sessionRecord();
    let save: StoredSaveRecord = {
      saveId: randomUUID(),
      campaignId: "test",
      blob: session.blob,
      savedAt: timestamp,
      savedAtSeq: 0,
      audience: "player",
      profileId,
    };
    await persistence.sessions.put(session);
    await persistence.saves.put(save);
    for (const initialization of [
      {},
      { kindProfileData: { nested: [1, 2] } },
      undefined,
    ]) {
      const { initialization: _oldSession, ...sessionBase } = session;
      const { initialization: _oldSave, ...saveBase } = save;
      session = {
        ...sessionBase,
        revision: session.revision + 1,
        ...(initialization === undefined ? {} : { initialization }),
      };
      save = {
        ...saveBase,
        ...(initialization === undefined ? {} : { initialization }),
      };
      await persistence.sessions.put(session);
      await persistence.saves.put(save);
      expect(await persistence.sessions.get(session.sessionId)).toStrictEqual(
        session,
      );
      expect(await persistence.saves.get(save.saveId)).toStrictEqual(save);
      expect(await persistence.saves.listByProfile(profileId)).toStrictEqual([
        save,
      ]);
      await expect(
        persistence.sessions.put({
          ...session,
          initialization: { kindProfileData: "stale" },
        }),
      ).rejects.toMatchObject({ name: SESSION_PERSISTENCE_CONFLICT });
      expect(await persistence.sessions.get(session.sessionId)).toStrictEqual(
        session,
      );
    }
  });

  function host(profiles = createInMemoryProfileStore(), hostKinds = kinds) {
    return createInMemorySessionStore({
      engine: createEngine({ kinds: hostKinds, registry }),
      registry,
      profiles,
      persistence: createPostgresPersistence(pool, hostKinds),
      clock: { now: () => timestamp },
    });
  }

  it("cold branches of the original and saved/loaded copy replay recorded data after the profile changes", async () => {
    const profiles = createInMemoryProfileStore();
    const profile = (await profiles.load(profileId)).profile;
    const seed = { boost: 7, nested: { flags: [true, false], value: null } };
    expect(
      (
        await profiles.save({
          ...profile,
          kindData: [{ kindId: "story-graph", dataVersion: 1, data: seed }],
        })
      ).ok,
    ).toBe(true);
    const store = host(profiles);
    const original = await store.createSession({
      campaignId: "test",
      profileId,
      seed: "fixed-seed",
    });
    const persistence = createPostgresPersistence(pool, kinds);
    const blobs: string[] = [];
    const scenes = [];
    for (let n = 0; n <= 2; n++) {
      if (n > 0)
        expect((await store.submitAction(original.sessionId, "bump")).ok).toBe(
          true,
        );
      blobs.push((await persistence.sessions.get(original.sessionId))!.blob);
      scenes.push(await store.getScene(original.sessionId));
    }
    const saved = await store.saveGame(original.sessionId);
    const sourceBefore = await persistence.sessions.get(original.sessionId);
    const saveBefore = await persistence.saves.get(saved.saveId);
    expect(saveBefore!.initialization).toStrictEqual({ kindProfileData: seed });
    expect(
      (
        await profiles.save({
          ...(await profiles.load(profileId)).profile,
          kindData: [
            { kindId: "story-graph", dataVersion: 1, data: { boost: 999 } },
          ],
        })
      ).ok,
    ).toBe(true);

    const loaded = await host(profiles).loadGame(saved.saveId);
    expect(
      (await persistence.sessions.get(loaded.sessionId))!.initialization,
    ).toStrictEqual({ kindProfileData: seed });
    for (const sourceId of [original.sessionId, loaded.sessionId]) {
      for (const n of [0, 1, 2]) {
        // A new adapter AND empty engine store for every source read.
        const cold = host(profiles);
        const branch = await cold.branchSession(sourceId, n);
        expect((await persistence.sessions.get(branch.sessionId))!.blob).toBe(
          blobs[n],
        );
        expect(branch.scene).toStrictEqual(scenes[n]);
        expect((await cold.getView(branch.sessionId)).kindView).toStrictEqual({
          count: n,
          seeded: seed,
        });
        expect(
          (await persistence.sessions.get(branch.sessionId))!.initialization,
        ).toStrictEqual({ kindProfileData: seed });
      }
    }
    expect(await persistence.sessions.get(original.sessionId)).toStrictEqual(
      sourceBefore,
    );
    expect(await persistence.saves.get(saved.saveId)).toStrictEqual(saveBefore);
    expect(
      (await profiles.load(profileId)).profile.kindData[0]!.data,
    ).toStrictEqual({ boost: 999 });
  });

  it("refuses ambiguous legacy sessions and loaded saves before any branch write", async () => {
    const store = host();
    const source = await store.createSession({ campaignId: "test", profileId });
    await store.submitAction(source.sessionId, "bump");
    const saved = await store.saveGame(source.sessionId);
    await pool.query(
      "update sessions set initialization = null where session_id = $1",
      [source.sessionId],
    );
    await pool.query(
      "update saves set initialization = null where save_id = $1",
      [saved.saveId],
    );
    const loaded = await host().loadGame(saved.saveId);
    const persistence = createPostgresPersistence(pool, kinds);
    expect(await persistence.sessions.get(loaded.sessionId)).not.toHaveProperty(
      "initialization",
    );
    const rowsBefore = (
      await pool.query("select * from sessions order by session_id")
    ).rows;
    for (const sourceId of [source.sessionId, loaded.sessionId]) {
      for (const n of [0, 1]) {
        await expect(host().branchSession(sourceId, n)).rejects.toMatchObject({
          operation: "branchSession",
          code: "invalid_state",
        });
        expect(
          (await pool.query("select * from sessions order by session_id")).rows,
        ).toStrictEqual(rowsBefore);
      }
    }
  });

  it.each([
    "anonymous legacy",
    "kind without profile data",
    "recorded empty wrapper",
  ])("accepts the safe case: %s", async (safeCase) => {
    const profiles = createInMemoryProfileStore();
    const { profileData: _unused, ...plainKind } = kind;
    const hostKinds =
      safeCase === "kind without profile data"
        ? ({ "story-graph": plainKind } as unknown as KindRegistry)
        : kinds;
    const store = host(profiles, hostKinds);
    const source = await store.createSession({
      campaignId: "test",
      ...(safeCase === "anonymous legacy" ? {} : { profileId }),
    });
    const persistence = createPostgresPersistence(pool, hostKinds);
    const blob = (await persistence.sessions.get(source.sessionId))!.blob;
    if (safeCase !== "recorded empty wrapper") {
      await pool.query(
        "update sessions set initialization = null where session_id = $1",
        [source.sessionId],
      );
    }
    // A profile that acquired data later must not reseed a recorded {} session either.
    expect(
      (
        await profiles.save({
          ...(await profiles.load(profileId)).profile,
          kindData: [
            { kindId: "story-graph", dataVersion: 1, data: { boost: 999 } },
          ],
        })
      ).ok,
    ).toBe(true);
    const branch = await host(profiles, hostKinds).branchSession(
      source.sessionId,
      0,
    );
    const row = (await persistence.sessions.get(branch.sessionId))!;
    expect(row.initialization).toStrictEqual({});
    expect(row.blob).toBe(blob);
  });
});
