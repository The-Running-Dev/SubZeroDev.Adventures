import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import {
  assertMinFontSize,
  assertMinGap,
  assertMinHitArea,
  assertMinLineHeight,
  assertNoHorizontalOverflow,
} from "../../test/browser/assertions";
import { clearEmulatedMedia, emulateMedia } from "../../test/browser/cdp";
import { reachEnded, reachPlaying } from "./fixtures";

/**
 * W66.1: the §8.1 type and hit-area floors, read as **computed** styles at
 * 320px -- never matched against the stylesheet's source text.
 */

afterEach(async () => {
  await page.viewport(1280, 800);
  await clearEmulatedMedia();
});

describe("type and target floors at 320px (W66.1)", () => {
  it("meets every type floor while playing", async () => {
    await page.viewport(320, 900);
    const { container } = await reachPlaying();

    const sceneBody = container.querySelector(".scene-body")!;
    assertMinFontSize(sceneBody, 1.125);
    assertMinLineHeight(sceneBody, 1.6);

    const choiceLabel = container.querySelector(".action-card button")!;
    assertMinFontSize(choiceLabel, 1.0625);

    const cabinetButton = container.querySelector(".cabinet-button")!;
    assertMinFontSize(cabinetButton, 1);

    const statLabel = container.querySelector(".stat-readouts dt");
    const statValue = container.querySelector(".stat-readouts dd");
    if (statLabel) assertMinFontSize(statLabel, 0.9375);
    if (statValue) assertMinFontSize(statValue, 0.9375);

    const receipt = container.querySelector(".arrival-receipt")!;
    assertMinFontSize(receipt, 0.875);

    const saveLamp = container.querySelector(".save-lamp")!;
    assertMinFontSize(saveLamp, 0.875);
  });

  it("meets every hit-area and gap floor while playing", async () => {
    await page.viewport(320, 900);
    const { container } = await reachPlaying();

    const choiceButtons = [
      ...container.querySelectorAll<HTMLElement>(".action-card button"),
    ];
    expect(choiceButtons.length).toBeGreaterThan(0);
    for (const button of choiceButtons) assertMinHitArea(button);

    const cards = [...container.querySelectorAll<HTMLElement>(".action-card")];
    for (let index = 1; index < cards.length; index += 1) {
      assertMinGap(cards[index - 1]!, cards[index]!);
    }

    assertMinHitArea(container.querySelector(".cabinet-button")!);
    assertMinHitArea(screen.getByRole("button", { name: /choices? ⌄/ }), 44);
  });

  it("meets the type and hit-area floors on an ended run", async () => {
    await page.viewport(320, 900);
    const { container } = await reachEnded();

    const sceneBody = container.querySelector(".scene-body")!;
    assertMinFontSize(sceneBody, 1.125);

    const placard = container.querySelector(".ending-placard")!;
    assertMinFontSize(placard, 0.875);

    for (const button of container.querySelectorAll<HTMLElement>(
      ".ending-controls .cabinet-button",
    )) {
      assertMinHitArea(button);
    }
  });
});

/**
 * W66.2/W66.5: below 768px a turn is two snap-scrolled pages in one ordinary
 * scrolling column -- the cue is a real button that reveals the choice page,
 * the pinned echo is a real button that returns to the scene page, and
 * neither is the only route (both pages are always in the DOM).
 */
describe("the phone reading model (W66.2)", () => {
  it("keeps both pages in the DOM and lets the cue and echo move between them", async () => {
    await page.viewport(320, 900);
    await emulateMedia([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const { container } = await reachPlaying();

    const sceneBody = container.querySelector<HTMLElement>(".scene-body")!;
    const deck = container.querySelector<HTMLElement>(".action-deck")!;
    // Both pages already exist -- nothing is conditionally unmounted.
    expect(sceneBody).toBeInTheDocument();
    expect(deck).toBeInTheDocument();

    const cue = screen.getByRole("button", { name: /choices? ⌄/ });
    cue.click();
    await waitFor(() => {
      const rect = deck.getBoundingClientRect();
      expect(rect.top).toBeLessThan(window.innerHeight);
      expect(rect.bottom).toBeGreaterThan(0);
    });

    const echo = screen.getByRole("button", { name: /^Scene:/ });
    echo.click();
    await waitFor(() => {
      const rect = sceneBody.getBoundingClientRect();
      expect(rect.top).toBeLessThan(window.innerHeight);
      expect(rect.bottom).toBeGreaterThan(0);
    });

    assertNoHorizontalOverflow();
  });

  it("lands a committed action on the new turn's scene page (W66.5)", async () => {
    await page.viewport(320, 900);
    await emulateMedia([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const { container, user } = await reachPlaying();

    screen.getByRole("button", { name: /choices? ⌄/ }).click();
    const firstChoice = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        ".action-card button:not(:disabled)",
      );
      expect(button).toBeTruthy();
      return button!;
    });
    await user.click(firstChoice);

    await waitFor(() => {
      const region = screen.getByRole("region", { name: "Scene" });
      expect(region).toHaveFocus();
      const rect = region.getBoundingClientRect();
      expect(rect.top).toBeLessThan(window.innerHeight);
      expect(rect.bottom).toBeGreaterThan(0);
    });

    assertNoHorizontalOverflow();
  });

  it("scrolls without animation when reduced motion is preferred (W66.10)", async () => {
    await page.viewport(320, 900);
    await emulateMedia([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await reachPlaying();

    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    screen.getByRole("button", { name: /choices? ⌄/ }).click();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
    spy.mockRestore();
  });

  it("does not snap or paginate at 768px and above", async () => {
    await page.viewport(768, 900);
    const { container } = await reachPlaying();

    const cue = container.querySelector(".scene-cue");
    expect(cue).not.toBeVisible();
    assertNoHorizontalOverflow();
  });
});

/**
 * W66.7: below 768px the cabinet is full-bleed -- page padding goes to zero
 * and the offset drop-shadow collapses to a single edge.
 */
describe("full-bleed cabinet below 768px (W66.7)", () => {
  it("removes the page inline padding and the offset shadow at 320px", async () => {
    await page.viewport(320, 900);
    const { container } = await reachPlaying();

    const main = document.querySelector(".play-main")!;
    const mainStyle = getComputedStyle(main);
    expect(mainStyle.paddingLeft).toBe("0px");
    expect(mainStyle.paddingRight).toBe("0px");

    const cabinet = container.querySelector(".cabinet")!;
    const cabinetStyle = getComputedStyle(cabinet);
    expect(cabinetStyle.boxShadow).not.toContain("8px");

    assertNoHorizontalOverflow();
  });

  it("keeps the double border and offset shadow at 1280px", async () => {
    await page.viewport(1280, 900);
    const { container } = await reachPlaying();

    const cabinet = container.querySelector(".cabinet")!;
    expect(getComputedStyle(cabinet).boxShadow).toContain("8px");
  });
});
