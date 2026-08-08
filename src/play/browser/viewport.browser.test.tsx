import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { assertNoHorizontalOverflow } from "../../test/browser/assertions";
import { clearEmulatedMedia, emulateMedia } from "../../test/browser/cdp";
import PlayApp from "../PlayApp";

/**
 * W65.2: the runner can set viewport width and height, and can emulate
 * `prefers-reduced-motion` and forced colours. These are the two real-device
 * capabilities W66's phone-composition criteria (14 §8) need that jsdom
 * cannot provide at all.
 */

const PORTRAIT_WIDTHS = [320, 360, 390, 414, 768, 1280] as const;

afterEach(async () => {
  await clearEmulatedMedia();
});

describe("viewport control (W65.2)", () => {
  it.each(PORTRAIT_WIDTHS)(
    "renders the shelf with no horizontal overflow at %dpx portrait",
    async (width) => {
      await page.viewport(width, 800);
      render(<PlayApp />);
      expect(
        await screen.findByRole("heading", { name: "Adventure disk library" }),
      ).toBeVisible();
      assertNoHorizontalOverflow();
    },
  );

  it("renders with no horizontal overflow at one landscape phone size", async () => {
    await page.viewport(844, 390);
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });
    assertNoHorizontalOverflow();
  });
});

describe("media-feature emulation (W65.2)", () => {
  it("can emulate prefers-reduced-motion", async () => {
    await emulateMedia([{ name: "prefers-reduced-motion", value: "reduce" }]);
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
      true,
    );
  });

  it("can emulate forced colours", async () => {
    await emulateMedia([{ name: "forced-colors", value: "active" }]);
    expect(window.matchMedia("(forced-colors: active)").matches).toBe(true);
  });
});
