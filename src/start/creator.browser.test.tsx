import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "../test/render";
import {
  assertMinHitArea,
  assertNoHorizontalOverflow,
} from "../test/browser/assertions";
import { Wizard } from "./Wizard";
import { saveDraft } from "./draft";
import { sampleDraft } from "./sample";
import { LanguageSelector } from "../components/LanguageSelector";
import { AdminPanel } from "../play/AdminPanel";
import type { BrowserDemo } from "../play/composition";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it.each([320, 390, 1280])(
  "preserves a draft while localizing every editor at %dpx",
  async (width) => {
    await page.viewport(width, 900);
    localStorage.setItem("subzerodev.play.theme.v1", "dos");
    saveDraft({ ...sampleDraft(), id: "my-story", title: "My authored title" });
    const user = userEvent.setup();
    const view = render(
      <>
        <LanguageSelector />
        <Wizard onExit={() => {}} />
      </>,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Language" }),
      "bg",
    );
    expect(screen.getByDisplayValue("My authored title")).toBeVisible();
    const buttons = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        ".gs-wizard-steps button",
      ),
    );
    for (const button of buttons) {
      await user.click(button);
      assertNoHorizontalOverflow();
      for (const control of view.container.querySelectorAll(
        ".gs-wizard button, .gs-field input, .gs-field select, .gs-field textarea, .gs-check-field",
      )) {
        assertMinHitArea(control);
      }
      const result = await axe.run(view.container, {
        resultTypes: ["violations"],
      });
      expect(
        result.violations,
        JSON.stringify(
          result.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => n.target),
          })),
        ),
      ).toEqual([]);
    }
    expect(
      JSON.parse(localStorage.getItem("subzerodev.play.draft.v1")!).title,
    ).toBe("My authored title");
  },
  30000,
);
it("keeps authorized admin forms usable in Bulgarian on a phone", async () => {
  await page.viewport(320, 900);
  localStorage.setItem("subzerodev.play.locale.v1", "bg");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).endsWith("/status")
          ? {
              isAdmin: true,
              status: {},
              sources: [],
              campaigns: [],
              extensions: [],
            }
          : { submissions: [] },
      ),
    ),
  );
  const view = render(
    <AdminPanel
      demo={
        { apiUrl: "https://api.invalid", catalog: [] } as unknown as BrowserDemo
      }
      syncing={false}
      syncError={undefined}
      lastSyncedAt="—"
      onSync={() => {}}
    />,
  );
  await screen.findByRole("textbox", { name: "Име" });
  assertNoHorizontalOverflow();
  for (const element of view.container.querySelectorAll(
    "button, input, textarea",
  ))
    assertMinHitArea(element);
  expect(
    (await axe.run(view.container, { resultTypes: ["violations"] })).violations,
  ).toEqual([]);
});
