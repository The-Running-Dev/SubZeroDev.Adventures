/**
 * Tests only: empty the content-epoch tables and drop this pool's runtime, so a suite starts
 * from no publication. The tables are insert-only in production (engine plan 54, §3.1), so a
 * suite that edits a fixture under the same version would otherwise meet the epoch an earlier
 * test published and be refused with `content_version_conflict`.
 */
import type { Pool } from "pg";
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
