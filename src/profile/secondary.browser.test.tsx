import { screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "../test/render";
import { Ranking } from "../ranking/Ranking";
import { MyContent } from "../content/MyContent";
import { Discussions } from "../discussions/Discussions";
import { StartPage } from "../start/StartPage";
import { assertNoHorizontalOverflow } from "../test/browser/assertions";
import "../start/start.css";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it.each([320, 390, 1280])(
  "keeps Bulgarian secondary screens usable at %dpx",
  async (width) => {
    localStorage.setItem("subzerodev.play.locale.v1", "bg");
    await page.viewport(width, 900);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/me")
          return Response.json({
            kind: "member",
            playerId: "p1",
            displayName: "Authored Name",
            signInProvider: null,
          });
        if (path.includes("/api/admin/"))
          return Response.json({ isAdmin: false });
        if (path === "/api/ranking")
          return Response.json({
            totalRanked: 1,
            entries: [
              {
                profileSlug: "author",
                displayName: "Authored Name",
                position: 1,
                absurdityIndex: 1200,
                badgeCount: 8,
                rejected: 12,
                endings: 4,
                moves: 128,
                crowned: true,
              },
            ],
          });
        if (path === "/api/content/mine")
          return Response.json({ submissions: [] });
        if (path === "/api/discussions")
          return Response.json({
            configured: true,
            canPost: true,
            threads: [],
            forum: "github",
          });
        throw Error(path);
      }),
    );
    for (const [component, title] of [
      [<Ranking apiUrl="https://api.invalid" />, "Класация на операторите"],
      [<MyContent apiUrl="https://api.invalid" />, "Моето съдържание"],
      [<Discussions apiUrl="https://api.invalid" />, "Канал на операторите"],
      [<StartPage />, "Какво искаш да направиш?"],
    ] as const) {
      const view = render(component);
      await screen.findByRole("heading", { name: title, level: 1 });
      if (title === "Класация на операторите")
        await screen.findByRole("link", { name: "Authored Name" });
      if (title === "Моето съдържание")
        await screen.findByRole("textbox", {
          name: "Постави кампания или разширение",
        });
      if (title === "Канал на операторите")
        await screen.findByRole("textbox", { name: "Заглавие" });
      assertNoHorizontalOverflow();
      for (const control of document.querySelectorAll(
        ".feature-page button, .feature-page input, .feature-page textarea, .gs-menu-row",
      ))
        expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(
          44,
        );
      view.unmount();
    }
  },
);
