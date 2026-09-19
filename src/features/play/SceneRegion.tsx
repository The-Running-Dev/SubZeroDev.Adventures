import { useMemo, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ThemeId } from "../../theme";

/** A brisk reveal, not a literal words-per-minute simulation -- floors and caps keep very short or very long excerpts from feeling instant or endless. */
const REVEAL_CHARS_PER_SECOND = 55;
const REVEAL_MIN_MS = 400;
const REVEAL_MAX_MS = 900;
/** Matrix reads slightly slower than the other skins -- part of its distinct pacing. */
const MATRIX_REVEAL_MULTIPLIER = 1.25;

function revealDuration(text: string, theme: ThemeId): number {
  const raw = (text.length / REVEAL_CHARS_PER_SECOND) * 1000;
  const clamped = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, raw));
  return theme === "matrix" ? clamped * MATRIX_REVEAL_MULTIPLIER : clamped;
}

/**
 * A labelled region with a short real heading, not the authored prose
 * itself -- a paragraph marked up as a heading makes the phone
 * screen-reader's heading rotor return a wall of story instead of a
 * landmark (14 §8.5).
 *
 * The story text is split into per-character spans, each with its own
 * `animation-delay`, so it visibly prints one character at a time rather
 * than as a single block-wide wipe. Every character is present in the DOM
 * from the first render -- only its `opacity` is staggered -- so
 * `textContent` is complete immediately: no test or screen reader has to
 * wait out the reveal to see the full scene.
 */
export function SceneRegion({
  text,
  regionRef,
  theme,
}: {
  text: string;
  regionRef: RefObject<HTMLElement | null>;
  theme: ThemeId;
}) {
  const { t } = useTranslation("play");
  const chars = useMemo(() => Array.from(text), [text]);
  const total = revealDuration(text, theme);
  const perChar = chars.length ? total / chars.length : 0;
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-labelledby="scene-heading"
      className="scene-region"
    >
      <h2 id="scene-heading" className="sr-only">
        {t("scene")}
      </h2>
      <p
        className="scene-body"
        style={{ "--reveal-total": `${total}ms` } as CSSProperties}
      >
        {chars.map((char, index) => (
          <span key={index} style={{ animationDelay: `${index * perChar}ms` }}>
            {char}
          </span>
        ))}
      </p>
    </section>
  );
}
