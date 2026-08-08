import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import PlayApp from "../PlayApp";
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
 * The phone reading model: one continuous column, choices directly under the
 * scene. This replaces §8.2's two snap-scrolled pages, where the choices sat a
 * screen away behind a cue button -- so the load-bearing assertion is now that
 * reaching them costs no interaction at all.
 */
describe("the phone reading model", () => {
  it("shows the choices on the same screen as the scene, with nothing to tap first", async () => {
    await page.viewport(320, 900);
    const { container } = await reachPlaying();

    const sceneBody = container.querySelector<HTMLElement>(".scene-body")!;
    const deck = container.querySelector<HTMLElement>(".action-deck")!;
    expect(sceneBody).toBeInTheDocument();

    // Both are in the first viewport already -- no cue, no jump, no scroll.
    const sceneRect = sceneBody.getBoundingClientRect();
    const deckRect = deck.getBoundingClientRect();
    expect(sceneRect.top).toBeLessThan(window.innerHeight);
    expect(deckRect.top).toBeLessThan(window.innerHeight);
    expect(deckRect.top).toBeGreaterThan(sceneRect.top);
    expect(window.scrollY).toBe(0);

    assertNoHorizontalOverflow();
  });

  it("retires the cue and echo controls the two-page model needed", async () => {
    await page.viewport(320, 900);
    const { container } = await reachPlaying();

    expect(container.querySelector(".scene-cue")).toBeNull();
    expect(container.querySelector(".scene-echo")).toBeNull();
    expect(screen.queryByRole("button", { name: /choices? ⌄/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Scene:/ })).toBeNull();
  });

  it("does not snap-scroll the document at any width", async () => {
    await page.viewport(320, 900);
    await reachPlaying();
    expect(getComputedStyle(document.documentElement).scrollSnapType).toBe(
      "none",
    );
    assertNoHorizontalOverflow();
  });

  it("keeps a committed action's new scene focused and in view (W66.5)", async () => {
    await page.viewport(320, 900);
    await emulateMedia([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const { container, user } = await reachPlaying();

    const firstChoice = container.querySelector<HTMLButtonElement>(
      ".action-card button:not(:disabled)",
    )!;
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
});

/**
 * BBS Terminal's command prompt is a keyboard affordance, and a phone has no
 * keyboard until one is summoned over a third of the screen. Every command it
 * accepts is already a button using the same numbering it prints, so the phone
 * simply uses those.
 */
describe("the BBS command prompt is desktop-only", () => {
  it("renders no command bar on a phone", async () => {
    await page.viewport(320, 900);
    localStorage.setItem("subzerodev.play.theme.v1", "bbs");
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await waitFor(() => {
      expect(document.querySelector(".bbs-prompt")).toBeNull();
    });
    expect(screen.queryByRole("textbox", { name: "Command" })).toBeNull();
    assertNoHorizontalOverflow();
  });

  it("still renders it on a desktop viewport", async () => {
    await page.viewport(1280, 900);
    localStorage.setItem("subzerodev.play.theme.v1", "bbs");
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    expect(
      await screen.findByRole("textbox", { name: "Command" }),
    ).toBeInTheDocument();
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
