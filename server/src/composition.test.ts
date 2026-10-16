/**
 * Proves the property the swap cell (#21, #22) depends on: `createServerDemo` builds a
 * fresh `Engine`/`SessionStore` on every call, but session state lives in Postgres
 * (`persistence.ts`), not in that store's in-process cache -- so a session created against
 * one build is still fully playable against a second, independently-built `ServerDemo`. If
 * this ever stopped holding, a content refresh would silently strand every session mid-run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { SessionStoreError } from "@the-running-dev/game-engine";
import { createServerDemo } from "./composition.js";

const databaseUrl = process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("createServerDemo rebuild", () => {
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
  });

  it("keeps a session playable across an independent rebuild", async () => {
    const before = await createServerDemo(pool);
    const { sessionId } = await before.store.createSession({
      campaignId: "what-would-lucifer-do",
      audience: "player",
    });

    // Simulates what `ContentCell.refresh()` does: build a whole new `ServerDemo` -- a new
    // engine, a new store with an empty in-process cache -- independent of the one the
    // session was created against.
    const after = await createServerDemo(pool);

    // If the rebuild had lost the session, this would throw `SessionStoreError` with code
    // `unknown_session` rather than resolving.
    const scene = await after.store.getScene(sessionId);
    expect(scene).toBeDefined();

    const view = await after.store.getView(sessionId);
    expect(view.status).toBe("active");
  });
});

/**
 * The session compare-and-swap (`persistence.ts`'s `sessions.put`) run under the real engine
 * store, not against a stub with the same predicate: the two defects it had -- comparing
 * `attempt_counter`, which a rejected submission advances without a write, and throwing an
 * unbranded error the engine reported as `storage_failure` -- only show up at this seam.
 */
describeIfDb("session compare-and-swap", () => {
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
  });

  async function firstAvailable(
    demo: Awaited<ReturnType<typeof createServerDemo>>,
    sessionId: string,
  ): Promise<string> {
    const scene = await demo.store.getScene(sessionId);
    const action = scene.actions.find((a) => a.available);
    expect(action).toBeDefined();
    return action!.id;
  }

  it("accepts a valid action after a rejected one", async () => {
    const demo = await createServerDemo(pool);
    const { sessionId } = await demo.store.createSession({
      campaignId: "what-would-lucifer-do",
      audience: "player",
    });

    const rejected = await demo.store.submitAction(sessionId, "no-such-action");
    expect(rejected.ok).toBe(false);

    const accepted = await demo.store.submitAction(
      sessionId,
      await firstAvailable(demo, sessionId),
    );
    expect(accepted.ok).toBe(true);
  });

  it("reports a lost race as concurrent_modification and lets the loser retry", async () => {
    const winner = await createServerDemo(pool);
    const { sessionId } = await winner.store.createSession({
      campaignId: "what-would-lucifer-do",
      audience: "player",
    });
    // A second, independent store reads the same revision into its own cache.
    const loser = await createServerDemo(pool);
    const actionId = await firstAvailable(loser, sessionId);

    expect((await winner.store.submitAction(sessionId, actionId)).ok).toBe(
      true,
    );

    const lost = await loser.store.submitAction(sessionId, actionId).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(lost).toBeInstanceOf(SessionStoreError);
    expect((lost as SessionStoreError).code).toBe("concurrent_modification");

    // The conflict evicted the stale record, so the retry re-reads the winner's write.
    const retried = await loser.store.submitAction(
      sessionId,
      await firstAvailable(loser, sessionId),
    );
    expect(retried.ok).toBe(true);
  });
});
