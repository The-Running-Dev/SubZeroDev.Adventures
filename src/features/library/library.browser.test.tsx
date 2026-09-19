import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { App } from "../../app/App";
import { assertNoHorizontalOverflow } from "../../test/browser/assertions";

afterEach(() => {
  cleanup();
  localStorage.removeItem("subzerodev.play.locale.v1");
});
it.each([320, 390, 1280])(
  "renders the Bulgarian library and authored campaign cards at %dpx",
  async (width) => {
    localStorage.setItem("subzerodev.play.locale.v1", "bg");
    await page.viewport(width, 900);
    render(<App />);
    await screen.findByRole("heading", {
      name: "Следващото ти лошо решение те чака.",
    });
    await screen.findByRole("link", { name: /Играй.*The Bureaucracy/ });
    assertNoHorizontalOverflow();
    for (const control of document.querySelectorAll(
      ".library-page input, .library-page select, .campaign-card-actions a",
    )) {
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  },
);
