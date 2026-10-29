/** Principal-bound persistence decorator. Routes never handle raw offline records. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { LoggedAction } from "@the-running-dev/game-engine";
import type { ServerDemo } from "../composition.js";
import { storedContentRow } from "../persistence.js";
import { OwnershipError } from "../store/ownedStore.js";
import {
  admits,
  ContentRefusal,
  gateExisting,
  gateNewStart,
  lineageOf,
  recordDependencies,
  runAdmitted,
  undeleted,
  type Admission,
} from "../content/admission.js";
import { grantTokenHash, TOMBSTONE_LIVE } from "../content/deletion.js";
import { validateBundle } from "../../../shared/offline/runtime.js";
import type {
  Bundle,
  Checkpoint,
  Download,
  SyncRequest,
  SyncReceipt,
} from "../../../shared/offline/protocol.js";
export class OfflineError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateRequest(value: unknown): asserts value is SyncRequest {
  const r = value as SyncRequest;
  if (
    !r ||
    r.schema !== 1 ||
    ![r.localRunId, r.idempotencyKey, r.grant, r.base].every(
      (x) => typeof x === "string" && uuid.test(x),
    ) ||
    !r.inputs ||
    typeof r.inputs.gameId !== "string" ||
    !uuid.test(r.inputs.gameId) ||
    typeof r.inputs.seed !== "string" ||
    r.inputs.seed.length > 200 ||
    r.inputs.audience !== "player" ||
    !Array.isArray(r.actions) ||
    r.actions.length > 5000
  )
    throw new OfflineError("invalid_actions", 400);
  // Untrusted input: read each entry as an action and reject anything that is not one.
  for (const [index, action] of (
    r.actions as Partial<LoggedAction>[]
  ).entries()) {
    if (
      !action ||
      action.seq !== index ||
      typeof action.actionId !== "string" ||
      action.actionId.length > 200 ||
      (action.params !== undefined &&
        (action.params === null ||
          Array.isArray(action.params) ||
          typeof action.params !== "object" ||
          Object.keys(action.params).length > 32 ||
          Object.values(action.params).some(
            (v) =>
              !(
                (typeof v === "string" && v.length <= 2000) ||
                typeof v === "boolean" ||
                (typeof v === "number" && Number.isFinite(v))
              ),
          )))
    )
      throw new OfflineError("invalid_actions", 400);
  }
}
export function ownedOfflineStore(
  pool: Pool,
  demo: ServerDemo,
  principal: { playerId: string; kind: string } | null,
) {
  const owner = principal?.kind === "member" ? principal.playerId : null;
  /** One epoch's bundle, cached on `demo`; an epoch whose requirements the offline runtime
   *  cannot meet stays online-only. */
  async function epochBundle(campaignId: string, campaignVersion: string) {
    const bundle = await demo.bundleForEpoch(campaignId, campaignVersion);
    if (!bundle) throw new OfflineError("unsupported_campaign");
    return bundle;
  }
  return {
    /**
     * A grant is a new start (D4 §3): fresh, it is admitted on the version the current
     * publication offers this caller; from a checkpoint, on the session's own epoch, gated as
     * existing content. Either way the bundle is that epoch's, and the grant insert is fenced
     * like a revision-0 session write -- refused, caught up, gated again and retried once.
     */
    async download(campaignId: string, sessionId?: string): Promise<Download> {
      const { runtime } = demo;
      const playerId = principal?.playerId ?? null;
      for (let attempt = 0; ; attempt++) {
        let admission: Admission;
        let campaignVersion: string;
        let checkpoint: Checkpoint | undefined;
        let revision: string | null = null;
        if (sessionId) {
          if (!owner) throw new OfflineError("member_required", 403);
          if (typeof sessionId !== "string" || !uuid.test(sessionId))
            throw new OfflineError("invalid_checkpoint", 400);
          const stored = await storedContentRow(pool, "sessions", sessionId);
          if (stored !== undefined && stored.profileId !== owner)
            throw new OwnershipError("offline_checkpoint");
          const { rows } = await pool.query(
            "select blob, offline_revision, replay_compatible from sessions where session_id=$1 and profile_id=$2",
            [sessionId, owner],
          );
          const row = rows[0];
          if (!row || !row.replay_compatible)
            throw new OfflineError("invalid_checkpoint");
          const lineage = lineageOf(row.blob);
          if (lineage.campaignId !== campaignId)
            throw new OfflineError("invalid_checkpoint");
          await gateExisting(
            runtime,
            "offline_checkpoint",
            lineage,
            playerId,
            await runtime.check(),
          );
          campaignVersion = lineage.campaignVersion;
          admission = {
            kind: "derived",
            campaignId,
            versions: lineage.versions,
            playerId,
          };
          const source = await epochBundle(campaignId, campaignVersion);
          const state = JSON.parse(row.blob);
          const inputs = {
            gameId: state.gameId,
            seed: state.seed,
            audience: "player" as const,
          };
          let frame;
          try {
            frame = validateBundle(source).replay(
              source.portable,
              inputs,
              state.actionLog,
            );
          } catch {
            throw new OfflineError("incompatible_checkpoint");
          }
          if (frame.blob !== row.blob)
            throw new OfflineError("incompatible_checkpoint");
          checkpoint = {
            inputs,
            blob: row.blob,
            actions: frame.actions,
            sessionId,
          };
          revision = row.offline_revision;
        } else {
          campaignVersion = gateNewStart(
            runtime,
            "offline_download",
            campaignId,
            playerId,
            await runtime.check(),
          );
          admission = { kind: "new", campaignId, campaignVersion, playerId };
        }
        const bundle = await epochBundle(campaignId, campaignVersion);
        const base = randomUUID();
        const inserted = await runAdmitted(admission, async () => {
          const db = await pool.connect();
          try {
            await db.query("begin");
            const admitted = await admits(db, {
              campaignId,
              campaignVersion,
              versions: new Set([campaignVersion]),
            });
            if (!admitted) {
              await db.query("rollback");
              return false;
            }
            await db.query(
              "insert into offline_grants(token,owner_id,bundle,checkpoint,source_revision) values($1,$2,$3,$4,$5)",
              [
                base,
                owner,
                JSON.stringify(bundle),
                checkpoint ? JSON.stringify(checkpoint) : null,
                revision,
              ],
            );
            await recordDependencies(
              db,
              { table: "grant_epochs", token: base },
              { campaignId, versions: new Set([campaignVersion]) },
            );
            await db.query("commit");
            return true;
          } catch (error) {
            await db.query("rollback");
            throw error;
          } finally {
            db.release();
          }
        });
        if (inserted)
          return { bundle, base, owner, ...(checkpoint ? { checkpoint } : {}) };
        if (attempt > 0)
          throw new ContentRefusal(
            "offline_download",
            "concurrent_modification",
          );
        await runtime.catchUp();
      }
    },
    async sync(value: unknown): Promise<SyncReceipt> {
      if (!owner) throw new OfflineError("member_required", 403);
      validateRequest(value);
      const r = value;
      const hash = createHash("sha256").update(JSON.stringify(r)).digest("hex");
      // The grant's epoch, gated as existing content before the transaction takes its
      // connection -- the gate reads through the pool, and may catch up: revoked since the
      // download is 403, an epoch this process can no longer run is 409 (D4 §3). A grant's
      // bundle never changes, so reading it ahead of the transaction is safe; a missing grant
      // is the transaction's own 403.
      const epoch = (
        await pool.query(
          "select bundle->'portable'->'campaign'->>'id' as campaign_id, bundle->'portable'->'campaign'->>'version' as campaign_version from offline_grants where token=$1 and owner_id=$2",
          [r.grant, owner],
        )
      ).rows[0];
      if (epoch)
        await gateExisting(
          demo.runtime,
          "offline_sync",
          {
            campaignId: epoch.campaign_id,
            campaignVersion: epoch.campaign_version,
          },
          owner,
          await demo.runtime.check(),
        );
      const db = await pool.connect();
      try {
        await db.query("begin");
        // Owner-wide serialization also protects idempotency keys reused on different run IDs.
        await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          owner,
        ]);
        const prior = (
          await db.query(
            "select request_hash,receipt from offline_receipts where owner_id=$1 and idempotency_key=$2",
            [owner, r.idempotencyKey],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== hash)
            throw new OfflineError("idempotency_mismatch");
          await db.query("commit");
          return prior.receipt as SyncReceipt;
        }
        const grant = (
          await db.query(
            "select *, bundle->'portable'->'campaign'->>'id' as campaign_id, bundle->'portable'->'campaign'->>'version' as campaign_version from offline_grants where token=$1 and owner_id=$2",
            [r.grant, owner],
          )
        ).rows[0];
        if (!grant) {
          // A grant purged with its content answers its owner 410 for the tombstone's window
          // (D3 §6); anyone else, and the owner afterwards, gets today's 403.
          const tombstone = await db.query(
            `select 1 from grant_tombstones where token_hash=$1 and owner_id=$2 and ${TOMBSTONE_LIVE}`,
            [grantTokenHash(r.grant), owner],
          );
          if (tombstone.rowCount !== 0)
            throw new ContentRefusal("offline_sync", "campaign_deleted");
          throw new OwnershipError("offline_sync");
        }
        const dependencies = {
          campaignId: grant.campaign_id as string,
          versions: new Set([grant.campaign_version as string]),
        };
        // The deletion fence: a sync that passes commits before the deletion is recorded, and
        // its run is purged with the grant; one that waited finds the key deleted.
        if (!(await undeleted(db, dependencies)))
          throw new ContentRefusal("offline_sync", "campaign_deleted");
        const bundle = grant.bundle as Bundle;
        if (
          r.bundleId !== bundle.id ||
          r.runtimeId !== bundle.runtimeId ||
          r.engineVersion !== bundle.engineVersion ||
          r.kindVersion !== bundle.kindVersion
        )
          throw new OfflineError("incompatible_bundle");
        let runtime: ReturnType<typeof validateBundle>;
        try {
          runtime = validateBundle(bundle);
        } catch (error) {
          throw new OfflineError(
            error instanceof Error ? error.message : "unsupported_runtime",
          );
        }
        const checkpoint = grant.checkpoint as Checkpoint | null;
        if (checkpoint) {
          // The owned grant and locked profile_id predicate authorize this checkpoint
          // on the transaction connection. Borrowing another pool client here can
          // deadlock when concurrent syncs occupy the rest of the pool.
          const source = (
            await db.query(
              "select offline_revision from sessions where session_id=$1 and profile_id=$2 for update",
              [checkpoint.sessionId, owner],
            )
          ).rows[0];
          if (!source || source.offline_revision !== grant.source_revision)
            throw new OfflineError("lineage_conflict");
          if (
            !isDeepStrictEqual(checkpoint.inputs, r.inputs) ||
            !isDeepStrictEqual(
              r.actions.slice(0, checkpoint.actions.length),
              checkpoint.actions,
            )
          )
            throw new OfflineError("invalid_checkpoint", 400);
        }
        const existing = (
          await db.query(
            "select * from offline_runs where owner_id=$1 and local_run_id=$2 for update",
            [owner, r.localRunId],
          )
        ).rows[0];
        if ((existing?.revision ?? r.grant) !== r.base)
          throw new OfflineError("lineage_conflict");
        if (
          existing &&
          (existing.grant_token !== r.grant ||
            !isDeepStrictEqual(existing.inputs, r.inputs))
        )
          throw new OfflineError("invalid_initialization", 400);
        if (existing) {
          const old = JSON.parse(existing.blob).actionLog;
          if (!isDeepStrictEqual(r.actions.slice(0, old.length), old))
            throw new OfflineError("lineage_conflict");
        }
        let frame;
        try {
          frame = runtime.replay(bundle.portable, r.inputs, r.actions);
        } catch {
          throw new OfflineError("invalid_actions", 400);
        }
        const receipt: SyncReceipt = {
          schema: 1,
          localRunId: r.localRunId,
          base: randomUUID(),
          blob: frame.blob,
          actionCount: frame.actions.length,
          eligibility: "personal-offline-only",
        };
        await db.query(
          `insert into offline_runs(owner_id,local_run_id,grant_token,inputs,blob,revision) values($1,$2,$3,$4,$5,$6)
     on conflict(owner_id,local_run_id) do update set blob=excluded.blob, revision=excluded.revision`,
          [
            owner,
            r.localRunId,
            r.grant,
            JSON.stringify(r.inputs),
            frame.blob,
            receipt.base,
          ],
        );
        await recordDependencies(
          db,
          { table: "run_epochs", ownerId: owner, localRunId: r.localRunId },
          dependencies,
        );
        await db.query(
          "insert into offline_receipts(owner_id,idempotency_key,request_hash,receipt) values($1,$2,$3,$4)",
          [owner, r.idempotencyKey, hash, JSON.stringify(receipt)],
        );
        await db.query("commit");
        return receipt;
      } catch (error) {
        await db.query("rollback");
        throw error;
      } finally {
        db.release();
      }
    },
    async archive() {
      if (!owner) throw new OfflineError("member_required", 403);
      const { rows } = await pool.query(
        "select local_run_id, blob, revision from offline_runs where owner_id=$1",
        [owner],
      );
      return {
        runs: rows.map((row) => ({
          localRunId: row.local_run_id,
          blob: row.blob,
          base: row.revision,
          eligibility: "personal-offline-only",
        })),
      };
    },
  };
}
