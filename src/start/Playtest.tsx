/**
 * The wizard's playtest step: the author's draft, running in the real engine.
 *
 * Not a preview and not a simulation of one. `useDraftPlaytest` builds the same
 * `SessionStore` the shipped local composition builds and hands it to the same
 * `BrowserClient` (`src/play/browser-client.ts`) the player uses, so what happens here is
 * what will happen after the draft is submitted -- including a choice that is unavailable
 * for a reason, which is exactly the thing an author most needs to see and the thing a
 * hand-rolled preview would get wrong.
 *
 * Presentational only. The run's state lives in the wizard (`draft-playtest.ts`'s hook, and
 * its header for why it has to live there rather than here).
 */
import type { PlaytestSession } from "./draft-playtest";

interface PlaytestProps {
  readonly session: PlaytestSession;
  /** False when the draft does not validate -- the runtime is never built in that case, and
   *  the panel says why instead of throwing out of `buildCatalog`. */
  readonly playable: boolean;
}

export function Playtest({ session, playable }: PlaytestProps) {
  const { state, busy, error, stale, start, choose } = session;
  const ended = state?.scene.status === "ended";

  return (
    <div className="gs-playtest">
      <div className="gs-playtest-bar">
        <span className="gs-eyebrow">PLAYTEST — REAL ENGINE, NOT SAVED</span>
        <button
          type="button"
          className="gs-btn gs-btn-primary"
          onClick={() => void start()}
          disabled={!playable || busy}
        >
          {state ? "RESTART ▸" : "RUN ▸"}
        </button>
      </div>

      {!playable && (
        <p className="gs-note" role="status">
          Fix the findings below first — a campaign has to validate before the
          engine will load it. That is the same gate it meets when you submit,
          so nothing here is stricter than the real thing.
        </p>
      )}
      {stale && (
        <p className="gs-note" role="status">
          You edited the draft, so that run was against content that no longer
          exists. Start a new one.
        </p>
      )}
      {error && (
        <p className="gs-error" role="alert">
          {error}
        </p>
      )}

      {state && (
        <div className="gs-playtest-stage">
          <p className="gs-eyebrow">{ended ? "ENDING REACHED" : "SCENE"}</p>
          <p className="gs-scene-text">{state.scene.body.text}</p>

          {ended ? (
            <p className="gs-note">
              This run reached an ending. Restart to try a different route.
            </p>
          ) : (
            <ul className="gs-playtest-actions" aria-label="Available choices">
              {state.actions.map((action, index) => (
                <li key={action.id}>
                  <button
                    type="button"
                    className="gs-btn"
                    disabled={busy || !action.available}
                    onClick={() => void choose(action.id)}
                  >
                    <span aria-hidden="true">{index + 1}. </span>
                    {action.label}
                  </button>
                  {!action.available && (
                    <span className="gs-dim"> — {action.reason}</span>
                  )}
                </li>
              ))}
              {state.actions.length === 0 && (
                <li className="gs-dim">
                  This scene offers no choices and is not an ending — the run
                  cannot continue.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
