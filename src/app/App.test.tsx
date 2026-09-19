import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const apiUrl = "https://api.example";
const member = {
  playerId: "player-1",
  kind: "member",
  displayName: "Operator",
  signInProvider: "oidc",
};
const fixtures = import.meta.glob("../../public/campaigns/*.json", {
  eager: true,
  import: "default",
});
let requests: string[];

beforeEach(() => {
  requests = [];
  window.history.replaceState({}, "", "/");
  localStorage.setItem("subzerodev.play.onboarding-seen.v1", "1");
  localStorage.setItem("subzerodev.play.theme.v1", "dos");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const fixture = url.split("/campaigns/")[1];
      if (fixture)
        return new Response(
          JSON.stringify(fixtures[`../../public/campaigns/${fixture}`]),
        );
      const body = url.endsWith("/api/saves")
        ? { saves: [] }
        : url.endsWith("/api/me")
          ? member
          : url.endsWith("/api/ranking")
            ? { entries: [], totalRanked: 0 }
            : url.endsWith("/api/progress")
              ? { progress: [] }
              : url.endsWith("/api/campaigns")
                ? {
                    campaigns: [
                      {
                        campaignId: "bulgaria-bureaucracy",
                        kindId: "story-graph",
                        version: "2.0.0",
                        title: "The Bureaucracy",
                        description: "Fixture",
                        duration: "~5 min",
                        contentNotice: "",
                        featured: false,
                        statBounds: {},
                        endingCount: 1,
                      },
                    ],
                    summaries: [],
                  }
                : url.endsWith("/api/badges")
                  ? { badges: [], records: null }
                  : url.endsWith("/api/profile/settings")
                    ? { public: false, slug: null }
                    : url.endsWith("/api/discussions/thread_1")
                      ? { configured: false }
                      : { isAdmin: false };
      return Response.json(body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("persistent application routing", () => {
  it("keeps one document, shell, theme and identity through Library → Standings → Profile → Back/Forward", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <App apiUrl={apiUrl} />
      </StrictMode>,
    );
    await screen.findByRole(
      "link",
      { name: /Play: The Bureaucracy/i },
      { timeout: 5000 },
    );
    await screen.findByRole("button", { name: /Signed in as Operator/i });
    const originalDocument = document;
    const main = screen.getByRole("main");
    const header = document.querySelector("header");
    const selector = screen.getByRole("combobox", { name: "DISPLAY MODE" });
    await user.selectOptions(selector, "amber");
    await user.click(screen.getByRole("link", { name: "Standings" }));
    await screen.findByRole("heading", { name: "Operator standings" });
    await user.click(
      screen.getByRole("button", { name: /Signed in as Operator/i }),
    );
    await user.click(screen.getByRole("link", { name: "Profile" }));
    await screen.findByRole("heading", { name: "Profile" });
    expect(window.location.pathname).toBe("/profile");
    await act(async () => window.history.back());
    await screen.findByRole("heading", { name: "Operator standings" });
    await act(async () => window.history.forward());
    await screen.findByRole("heading", { name: "Profile" });
    expect(document).toBe(originalDocument);
    expect(screen.getByRole("main")).toBe(main);
    expect(document.querySelector("header")).toBe(header);
    expect(screen.getByRole("combobox", { name: "DISPLAY MODE" })).toBe(
      selector,
    );
    expect(selector).toHaveValue("amber");
    expect(requests.filter((url) => url.endsWith("/api/me"))).toHaveLength(1);
  });

  it.each([
    ["/ranking", "Operator standings"],
    ["/profile", "Profile"],
    ["/content", "My content"],
    ["/start", "What are you here to do?"],
    ["/u/another-player", "Public profile"],
    ["/discussions", "Operator channel"],
    ["/discussions/thread_1", "Thread"],
    ["/oauth/consent?authorization_id=example", "Sign-in request"],
    ["/discussions/invalid!", "Page not found"],
    ["/missing", "Page not found"],
  ])("opens %s directly under the shared shell", async (path, heading) => {
    window.history.replaceState({}, "", path);
    render(<App />);
    await screen.findByRole("heading", { name: heading });
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  it("retains legacy campaign query links when entered from another route", async () => {
    window.history.replaceState({}, "", "/start");
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("link", { name: /Play the guided intro/i }),
    );
    await waitFor(() =>
      expect(document.querySelector(".onboarding-active")).not.toBeNull(),
    );
    expect(window.location.search).toBe("?campaign=getting-started");
    expect(
      screen.queryByRole("navigation", { name: "Primary" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a first-ever visit on the getting-started wizard instead of the library", async () => {
    // The library home is what a returning visitor sees; the wizard still owns the very first
    // load, and `PlayApp` is the only thing that can auto-start it.
    localStorage.removeItem("subzerodev.play.onboarding-seen.v1");
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".onboarding-active")).not.toBeNull(),
    );
    expect(localStorage.getItem("subzerodev.play.onboarding-seen.v1")).toBe(
      "1",
    );
    expect(
      screen.queryByRole("heading", { name: "Adventure library" }),
    ).not.toBeInTheDocument();
  });

  it("keeps navigation available when the catalog fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("link", { name: "Standings" }));
    await screen.findByRole("heading", { name: "Operator standings" });
  });
});
