import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { reachPlaying } from "../play/browser/fixtures";
import { assertNoHorizontalOverflow } from "../test/browser/assertions";
import { render } from "../test/render";
import PlayApp from "../play/PlayApp";
import userEvent from "@testing-library/user-event";

afterEach(() => {
  cleanup();
  localStorage.removeItem("subzerodev.play.locale.v1");
});

describe("persistent responsive shell", () => {
  it.each([320, 390, 1280])(
    "keeps navigation and Bulgarian preferences usable at %dpx",
    async (width) => {
      await page.viewport(width, 800);
      render(<PlayApp />);
      const user = userEvent.setup();
      await screen.findByRole("heading", { name: "Adventure disk library" });
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Language" }),
        "bg",
      );
      const nav = screen.getByRole("navigation", { name: "Основна навигация" });
      expect(nav).toBeVisible();
      assertNoHorizontalOverflow();
      for (const control of nav.querySelectorAll("a, button, summary")) {
        if ((control as HTMLElement).offsetHeight === 0) continue;
        expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(
          44,
        );
      }
      const more = screen.getByText("Още", { exact: true });
      await user.click(more);
      expect(
        screen.getByRole("link", { name: "Моето съдържание" }),
      ).toBeVisible();
      await user.keyboard("{Escape}");
      expect(more).toHaveFocus();
      expect(more.closest("details")).not.toHaveAttribute("open");
      expect(document.documentElement.lang).toBe("bg");
    },
  );

  it("switches language during play without restarting the engine or replacing the scene", async () => {
    await page.viewport(320, 800);
    const { user, container } = await reachPlaying();
    const scene = container.querySelector(".scene-region");
    const prose = scene?.textContent;
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Language" }),
      "bg",
    );
    expect(container.querySelector(".scene-region")).toBe(scene);
    expect(scene?.textContent).toBe(prose);
    expect(screen.getByRole("combobox", { name: "Език" })).toHaveValue("bg");
    assertNoHorizontalOverflow();
    expect(
      getComputedStyle(
        screen.getByRole("navigation", { name: "Основна навигация" }),
      ).position,
    ).toBe("static");
  });
});
