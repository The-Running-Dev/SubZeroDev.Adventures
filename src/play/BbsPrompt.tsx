import { useEffect, useRef, useState, type FormEvent } from "react";

/**
 * Deliberately dumb: it owns only its own input value and the last response
 * string, and knows nothing about the game. `onCommand` gets the trimmed,
 * non-empty text and returns a response to echo, or `undefined` for none.
 *
 * This theme's whole point is playing without touching the mouse, so the
 * input grabs focus on mount, reclaims it after every typed command, and
 * reclaims it again whenever `focusToken` changes -- which `PlayApp.tsx`
 * derives from the game state, so a *mouse* click (a dossier tile, an
 * on-screen action, Quit to library) hands focus straight back to the
 * command line too, not just a typed one. `PlayApp.tsx` also skips its own
 * scene-focus effect while this theme is active, so nothing fights this.
 */
export function BbsPrompt({
  sigil,
  hint,
  focusToken,
  resetToken,
  busy,
  onCommand,
}: {
  sigil: string;
  hint: string;
  focusToken: string;
  resetToken: number;
  /** True while a submitted command's engine call is still in flight -- typing ahead of it raced the player into a scene that hadn't loaded yet. */
  busy: boolean;
  onCommand: (command: string) => string | undefined;
}) {
  const [value, setValue] = useState("");
  const [response, setResponse] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [focusToken, busy]);

  /** `resetToken` only bumps on a return to the shelf -- a stale "Invalid choice" or echoed action from the last run shouldn't linger into the next one. */
  useEffect(() => {
    setResponse(undefined);
    setValue("");
  }, [resetToken]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const command = value.trim();
    if (command) {
      setResponse(onCommand(command));
      setValue("");
    }
    inputRef.current?.focus();
  }

  return (
    <div className="bbs-prompt">
      {response && (
        <p className="bbs-response" role="status">
          {response}
        </p>
      )}
      <p className="bbs-hint">{busy ? "Loading…" : hint}</p>
      <form className="bbs-input-line" onSubmit={handleSubmit}>
        <span className="bbs-sigil" aria-hidden="true">
          {sigil}
        </span>
        <input
          ref={inputRef}
          className="bbs-input"
          type="text"
          aria-label="Command"
          autoComplete="off"
          autoFocus
          disabled={busy}
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </form>
    </div>
  );
}
