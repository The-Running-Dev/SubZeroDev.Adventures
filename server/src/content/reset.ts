/**
 * Tests only: empty the content-epoch tables and drop this pool's runtime, so a suite starts
 * from no publication. The tables are insert-only in production (engine plan 54, §3.1), so a
 * suite that edits a fixture under the same version would otherwise meet the epoch an earlier
 * test published and be refused with `content_version_conflict`.
 */
import type { Pool } from "pg";
import type { SessionStore } from "@the-running-dev/game-engine";
import type { ServerDemo } from "../composition.js";
import { gateNewStart, runAdmitted } from "./admission.js";
import { forgetContentRuntime } from "./runtime.js";

export async function resetContentEpochs(pool: Pool): Promise<void> {
  await pool.query(
    "truncate content_publication_entries, content_epochs, content_current, content_publications restart identity cascade",
  );
  await pool.query(
    "insert into content_current (singleton, publication_id) values (true, null)",
  );
  forgetContentRuntime(pool);
}

/**
 * Tests only: `createSession` on `demo`'s raw store, admitted as a new start the way
 * `ownedStore` admits one. The fence refuses a revision-0 session write with no admission, so a
 * suite driving the raw store has to pass a gate like every route does.
 */
export async function createAdmitted(
  demo: ServerDemo,
  config: Parameters<SessionStore["createSession"]>[0],
  playerId: string | null = null,
) {
  const campaignVersion = gateNewStart(
    demo.runtime,
    "createSession",
    config.campaignId,
    playerId,
    await demo.runtime.check(),
  );
  return runAdmitted(
    { kind: "new", campaignId: config.campaignId, campaignVersion, playerId },
    () => demo.store.createSession(config),
  );
}
