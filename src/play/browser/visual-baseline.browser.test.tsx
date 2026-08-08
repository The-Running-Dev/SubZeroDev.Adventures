import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { clearEmulatedMedia, emulateMedia } from "../../test/browser/cdp";
import {
  reachEnded,
  reachPersistenceWarning,
  reachPlaying,
  reachUnavailableChoice,
} from "./fixtures";

/**
 * W65.5: visual snapshots of the *currently shipped* `/play/` rendering,
 * committed as the baseline W66 must diff against before it moves any CSS.
 * The reduced-motion override already shipped in `play.css` (W63.9) freezes
 * the marquee's blinking-cursor animation, and no web font is loaded, so no
 * further pinning is needed for a stable capture (W65.6).
 */

const WIDTHS = [320, 390, 768, 1280] as const;

beforeEach(async () => {
  // The marquee's cursor-blink animation (W63.9's own reduced-motion
  // override freezes it, but only when the media feature is actually
  // active) otherwise captures at a random phase and, at some widths, a
  // 1px difference in its glyph cascades into a line-wrap change --
  // exactly the flake this pins down (W65.6).
  await emulateMedia([{ name: "prefers-reduced-motion", value: "reduce" }]);
});

afterEach(async () => {
  await page.viewport(1280, 800);
  await clearEmulatedMedia();
});

/**
 * `PlayApp` never passes a seed, so stat values, achievement counts, and
 * journey excerpts along an otherwise-scripted route are genuinely random
 * from one run to the next -- including their *text length*, which can
 * change how many lines a box wraps to and shift the page height by a
 * pixel even while the box stays invisible. `display: none` removes that
 * residual jitter. These are pure game-content text regions W66 does not
 * anchor its own layout on, so excluding them entirely from this baseline
 * does not weaken what the baseline exists to prove.
 */
function hideNonDeterministicContent(container: Element): void {
  const selectors = [".stat-readouts", ".journey-log", ".achievement-note"];
  for (const selector of selectors) {
    for (const el of container.querySelectorAll<HTMLElement>(selector)) {
      el.style.display = "none";
    }
  }
}

/**
 * Reaching "playing"/"ended"/"unavailable-choice" moves focus to the scene
 * heading (14 §8.5, unchanged by W65), which scrolls the page. An element
 * screenshot captures whatever is currently scrolled into view, so a run
 * that focused a lower heading than the reference run was taken from
 * produces a spuriously large diff. Resetting scroll position right before
 * capture removes that as a variable.
 */
function resetScroll(): void {
  window.scrollTo(0, 0);
}

describe("visual baseline (W65.5)", () => {
  for (const width of WIDTHS) {
    it(`playing at ${width}px`, async () => {
      await page.viewport(width, 900);
      const { container } = await reachPlaying();
      resetScroll();
      await expect
        .element(page.elementLocator(container))
        .toMatchScreenshot(`playing-${width}`);
    });

    it(`ended at ${width}px`, async () => {
      await page.viewport(width, 900);
      const { container } = await reachEnded();
      hideNonDeterministicContent(container);
      resetScroll();
      await expect
        .element(page.elementLocator(container))
        .toMatchScreenshot(`ended-${width}`);
    });

    it(`persistence-warning at ${width}px`, async () => {
      await page.viewport(width, 900);
      const { container, restore } = await reachPersistenceWarning();
      try {
        resetScroll();
        await expect
          .element(page.elementLocator(container))
          .toMatchScreenshot(`persistence-warning-${width}`);
      } finally {
        restore();
      }
    });

    it(`unavailable-choice at ${width}px`, async () => {
      await page.viewport(width, 900);
      const { container } = await reachUnavailableChoice();
      hideNonDeterministicContent(container);
      resetScroll();
      await expect
        .element(page.elementLocator(container))
        .toMatchScreenshot(`unavailable-choice-${width}`);
    });
  }
});
