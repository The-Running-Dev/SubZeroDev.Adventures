/**
 * Proves the property the swap cell (#21, #22) depends on: `createServerDemo` builds a
 * fresh `Engine`/`SessionStore` on every call, but session state lives in Postgres
 * (`persistence.ts`), not in that store's in-process cache -- so a session created against
 * one build is still fully playable against a second, independently-built `ServerDemo`. If
 * this ever stopped holding, a content refresh would silently strand every session mid-run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
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
