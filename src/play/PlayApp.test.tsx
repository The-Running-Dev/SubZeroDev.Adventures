import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import PlayApp from "./PlayApp";
import manifestJson from "../../public/campaigns/manifest.json";
import whatWouldLuciferDoJson from "../../public/campaigns/what-would-lucifer-do.json";
import whatWouldLuciferDoEngineersCutJson from "../../public/campaigns/what-would-lucifer-do-engineers-cut.json";
import luciferChroniclesJson from "../../public/campaigns/lucifer-chronicles.json";
import bulgariaBureaucracyJson from "../../public/campaigns/bulgaria-bureaucracy.json";
import bulgariaReturnJson from "../../public/campaigns/bulgaria-return.json";
import bulgariaDrivingJson from "../../public/campaigns/bulgaria-driving.json";
import bulgariaInheritanceJson from "../../public/campaigns/bulgaria-inheritance.json";
import bulgariaEnterpriseJson from "../../public/campaigns/bulgaria-enterprise.json";
import sakiQuestJson from "../../public/campaigns/saki-quest-for-redemption.json";

// SPIKE: same fetch stub as browser-client.test.ts — `PlayApp` now loads its catalog
// with a `fetch`, so every test must wait for that to resolve before the previously
// synchronous dossier-shelf queries below will find anything. See plans/spike-notes.md.
const exportedCampaigns: Readonly<Record<string, unknown>> = {
  "manifest.json": manifestJson,
  "what-would-lucifer-do.json": whatWouldLuciferDoJson,
  "what-would-lucifer-do-engineers-cut.json":
    whatWouldLuciferDoEngineersCutJson,
  "lucifer-chronicles.json": luciferChroniclesJson,
  "bulgaria-bureaucracy.json": bulgariaBureaucracyJson,
  "bulgaria-return.json": bulgariaReturnJson,
  "bulgaria-driving.json": bulgariaDrivingJson,
  "bulgaria-inheritance.json": bulgariaInheritanceJson,
  "bulgaria-enterprise.json": bulgariaEnterpriseJson,
  "saki-quest-for-redemption.json": sakiQuestJson,
};
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const fileName = url.split("/campaigns/")[1];
    const body = fileName ? exportedCampaigns[fileName] : undefined;
    if (body === undefined) throw new Error(`Unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("PlayApp cabinet presentation", () => {
  it("renders a selectable dossier shelf and opens a plain-language briefing", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);

    expect(
      await screen.findByRole("heading", { name: "Adventure disk library" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));

    expect(
      screen.getByRole("heading", { name: "The Bureaucracy" }),
    ).toBeVisible();
    expect(
      screen.getByText("Estimated duration: 10–15 min per route"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Load selected adventure" }),
    ).toBeVisible();
  });

  it("loads the adventure directly, with no interstitial notice to click through", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );

    expect(
      await screen.findByText(/handwritten/i, { selector: ".scene-body" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("dialog", { name: "Before loading this program" }),
    ).not.toBeInTheDocument();
  });

  it("shows a permanent link for the selected campaign that loads it directly", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));

    const link = screen.getByRole("link", { name: /\?campaign=/ });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("?campaign=bulgaria-bureaucracy"),
    );
  });

  it("auto-loads the adventure named by a permanent ?campaign= link", async () => {
    const originalLocation = window.location.href;
    window.history.pushState({}, "", "/?campaign=bulgaria-bureaucracy");
    try {
      render(<PlayApp />);
      expect(
        await screen.findByText(/handwritten/i, { selector: ".scene-body" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Adventure disk library" }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", originalLocation);
    }
  });

  it("resumes an existing local save when opened via its permanent ?campaign= link, rather than restarting", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /Wait for the municipal registry/i,
      }),
    );
    const advancedScene =
      document.querySelector(".scene-body")?.textContent ?? "";
    expect(advancedScene).not.toMatch(/handwritten/i);
    unmount();

    const originalLocation = window.location.href;
    window.history.pushState({}, "", "/?campaign=bulgaria-bureaucracy");
    try {
      render(<PlayApp />);
      expect(
        await screen.findByRole("heading", { name: "The Bureaucracy" }),
      ).toBeVisible();
      expect(document.querySelector(".scene-body")?.textContent).toBe(
        advancedScene,
      );
      expect(
        screen.queryByRole("heading", { name: "Adventure disk library" }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, "", originalLocation);
    }
  });

  it("ignores a submission that resolves after the player quits to the library", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );

    const action = await screen.findByRole("button", {
      name: /Wait for the municipal registry/i,
    });
    await act(async () => {
      action.click();
      screen.getByRole("button", { name: "Quit to library" }).click();
      await Promise.resolve();
    });

    expect(
      screen.getByRole("heading", { name: "Adventure disk library" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Quit to library" }),
    ).not.toBeInTheDocument();
  });

  it("starts the cabinet without exposing engine internals", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );

    expect(
      await screen.findByText(/handwritten/i, { selector: ".scene-body" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Player status" }),
    ).toBeVisible();
    expect(screen.getByText("GAME SAVED")).toBeVisible();
    expect(
      screen.queryByText(/actionLog|kindState|seed/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("PROGRAM LOADED. YOUR STORY BEGINS HERE."),
    ).toBeVisible();
  });

  it("marks the authored scene as a labelled region with a short real heading, not the prose itself (W66.8)", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );
    await screen.findByText(/handwritten/i, { selector: ".scene-body" });

    const region = screen.getByRole("region", { name: "Scene" });
    expect(region).toHaveFocus();
    expect(
      screen.queryByRole("heading", { name: /handwritten/i }),
    ).not.toBeInTheDocument();
  });

  it("names the scene-cue button after exactly the shown choices (W66's phone reading model)", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /Enterprise/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );
    await screen.findByRole("button", { name: /choices? ⌄/ });

    const deck = document.querySelector(".action-deck");
    const shownChoices = deck?.querySelectorAll(".action-card").length ?? 0;
    expect(shownChoices).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", {
        name: new RegExp(`^${shownChoices} choices?`),
      }),
    ).toBeVisible();
  });

  it("records only committed projected pages in the read-only journey", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /Wait for the municipal registry/i,
      }),
    );

    expect(screen.getByText("Last command")).toBeVisible();
    expect(screen.getByText("Wait for the municipal registry")).toBeVisible();
    expect(screen.getByText("// accepted")).toBeVisible();

    await user.click(screen.getByText("Travel log"));
    expect(screen.getByText(/Where I came from:/)).toBeVisible();
    expect(
      screen.queryByText(/actionLog|kindState|currentNodeId|seed/i),
    ).not.toBeInTheDocument();
  });

  it("offers a resume for a campaign with a local save, and reloads that run", async () => {
    const user = userEvent.setup();
    render(<PlayApp />);
    await screen.findByRole("heading", { name: "Adventure disk library" });

    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    await user.click(
      screen.getByRole("button", { name: "Load selected adventure" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /Wait for the municipal registry/i,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Quit to library" }));
    await user.click(screen.getByRole("button", { name: /The Bureaucracy/i }));
    const resumeButton = await screen.findByRole("button", {
      name: "Resume saved run",
    });
    await user.click(resumeButton);

    expect(
      await screen.findByRole("heading", { name: "The Bureaucracy" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Adventure disk library" }),
    ).not.toBeInTheDocument();
  });
});
