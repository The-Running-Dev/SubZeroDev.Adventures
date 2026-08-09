/**
 * Replay -- built entirely on exported engine API (`createGame`, `submitAction`, `scene`,
 * `serialize`, `deserialize`), the same loop `runFixture`
 * (`engine/src/engine/src/core/determinism/harness.ts`) documents as the replay
 * regression oracle's pseudocode, extended here to capture a `Scene` per step instead of
 * only the final `serialize()`.
 *
 * A stored blob already carries everything replay needs: `GameState.seed` and
 * `GameState.actionLog` (04-core.md's "replay spine") -- no new schema, no new upstream
 * export.
 */
import type { Engine, GameState, Scene } from "@the-running-dev/game-engine";

type LoggedAction = GameState["actionLog"][number];

export interface ReplayStep {
  seq: number;
  actionId: string;
  scene: Scene;
}

export interface ReplayResult {
  steps: ReplayStep[];
  finalBlob: string;
}

/**
 * Replays a stored session's action log from scratch. `upTo`, when given, stops after
 * that many logged actions (exclusive of any beyond it) -- what `branch` uses to land on
 * an arbitrary past step.
 *
 * `makeReplayEngine` must build an `Engine` whose `IdSource.newGameId()` returns the
 * *original* session's `gameId` -- the default `IdSource` mints a fresh random one on
 * every `createGame` call, which would never reproduce a real session's stored blob no
 * matter how faithfully the action log replays (see `ServerDemo.createReplayEngine`'s doc
 * comment). `deserializerEngine` only needs to `deserialize` the stored blob, which does
 * not touch `IdSource` -- the shared, non-replay engine is fine for that half.
 */
export function replay(
  deserializerEngine: Engine,
  makeReplayEngine: (gameId: string) => Engine,
  blob: string,
  upTo?: number,
): ReplayResult {
  const deserialized = deserializerEngine.deserialize(blob);
  if (!deserialized.ok || !deserialized.value) {
    throw new Error(
      "replay: stored blob failed to deserialize against this engine",
    );
  }
  const { campaignId, seed, actionLog, gameId } = deserialized.value;
  const engine = makeReplayEngine(gameId);

  const created = engine.createGame({ campaignId, seed });
  if (!created.ok || !created.value) {
    throw new Error(`replay: createGame rejected for campaign "${campaignId}"`);
  }

  const steps: ReplayStep[] = [];
  let state = created.value;
  const log: readonly LoggedAction[] =
    upTo === undefined ? actionLog : actionLog.slice(0, upTo);

  for (const logged of log) {
    const result = engine.submitAction(state, logged.actionId, logged.params);
    if (!result.ok || !result.value) {
      throw new Error(
        `replay: submitAction("${logged.actionId}") rejected at seq ${logged.seq} -- the stored log no longer replays against this engine`,
      );
    }
    state = result.value;
    steps.push({
      seq: logged.seq,
      actionId: logged.actionId,
      scene: engine.scene(state),
    });
  }

  return { steps, finalBlob: engine.serialize(state) };
}

export interface VerifyResult {
  ok: boolean;
  skipped?: "not_replay_compatible";
  storedBlob?: string;
  replayedBlob?: string;
}

/** The regression oracle, applied to one stored session rather than a fixture corpus:
 *  does a from-scratch replay of this session's own action log reach the exact stored
 *  blob? A migrated lineage (`replayCompatible: false`, 04-core.md §10.2) is no longer
 *  byte-replayable by contract, so it is reported as skipped rather than a false failure. */
export function verifyReplay(
  deserializerEngine: Engine,
  makeReplayEngine: (gameId: string) => Engine,
  storedBlob: string,
  replayCompatible: boolean,
): VerifyResult {
  if (!replayCompatible) return { ok: false, skipped: "not_replay_compatible" };
  const { finalBlob } = replay(
    deserializerEngine,
    makeReplayEngine,
    storedBlob,
  );
  return finalBlob === storedBlob
    ? { ok: true }
    : { ok: false, storedBlob, replayedBlob: finalBlob };
}
