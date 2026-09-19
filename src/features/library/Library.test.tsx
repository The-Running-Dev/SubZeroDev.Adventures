import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app/App";
import type { BrowserCampaign } from "../../play/composition";

const campaign = (id: string, extra = {}): BrowserCampaign => ({
  campaignId: id,
  kindId: "story-graph",
  version: "1",
  title: id,
  description: `Story ${id}`,
  duration: "10 min",
  contentNotice: "",
  featured: false,
  statBounds: {},
  endingCount: 2,
  ...extra,
});
let member: boolean;
let failStats: boolean;
let failCatalog: boolean;
beforeEach(() => {
  member = false;
  failStats = false;
  failCatalog = false;
  window.history.replaceState({}, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const payload: Record<string, unknown> = {
        "/api/me": {
          playerId: member ? "player-1" : null,
          kind: member ? "member" : "anonymous",
          displayName: member ? "Ada" : null,
          signInProvider: null,
        },
        "/api/campaigns": {
          campaigns: [
            campaign("First", { featured: true }),
            campaign("Latest"),
            campaign("Secret intro", { hidden: true }),
          ],
        },
        "/api/progress": {
          progress: [
            {
              campaignId: "First",
              status: "ended",
              stepCount: 23,
              achievements: ["a"],
              endings: { discovered: ["end"], total: 2 },
              sessionCount: 1,
              firstPlayedAt: "2026-09-01",
              lastPlayedAt: "2026-09-02",
            },
          ],
        },
        "/api/saves": {
          saves: [
            {
              campaignId: "First",
              saveId: "old",
              savedAt: "2026-09-01",
              savedAtSeq: 2,
            },
            {
              campaignId: "Latest",
              saveId: "new",
              savedAt: "2026-09-02",
              savedAtSeq: 4,
            },
          ],
        },
        "/api/badges": {
          badges: [
            { badgeId: "first-steps", unlockedAt: "2026-09-01T00:00:00Z" },
          ],
          records: null,
        },
        "/api/stats": {
          players: 42,
          sessions: 91,
          sessionsFinished: 31,
          campaignsPlayed: 7,
          stepsTaken: 1234,
          achievementsUnlocked: 27,
          badgesUnlocked: 16,
        },
      };
      if (
        (path === "/api/stats" && failStats) ||
        (path === "/api/campaigns" && failCatalog)
      )
        return Response.json(
          { error: { code: "request_failed" } },
          { status: 503 },
        );
      return Response.json(payload[path] ?? { isAdmin: false });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("library home", () => {
  it("shows public stats from the API, filters actual featured metadata and excludes hidden campaigns", async () => {
    const user = userEvent.setup();
    render(<App apiUrl="https://api.test" />);
    await screen.findByRole("link", { name: "Play: First" });
    expect(screen.queryByText("Secret intro")).not.toBeInTheDocument();
    expect(screen.getByText("42")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Continue playing" }),
    ).not.toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Show" }),
      "featured",
    );
    expect(screen.getByRole("link", { name: "Play: First" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Play: Latest" }),
    ).not.toBeInTheDocument();
  });
  it("uses the latest real save and keeps personal achievements separate from public aggregates", async () => {
    member = true;
    render(<App apiUrl="https://api.test" />);
    const section = (
      await screen.findByRole("heading", { name: "Continue playing" })
    ).closest("section")!;
    await within(section).findByRole("link", { name: "Continue: Latest" });
    expect(within(section).queryByText("First")).not.toBeInTheDocument();
    const record = (
      await screen.findByRole("heading", { name: "Your record · Ada" })
    ).closest("section")!;
    await within(record).findByText("23");
    expect(
      within(record).getByText("1 badge unlocked · View badges"),
    ).toBeVisible();
    const network = screen
      .getByRole("heading", { name: "Across the network" })
      .closest("section")!;
    expect(within(network).getByText("27")).toBeVisible();
  });
  it("localizes controls without translating authored stories or resetting search", async () => {
    const user = userEvent.setup();
    render(<App apiUrl="https://api.test" />);
    await screen.findByRole("link", { name: "Play: First" });
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "First" },
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Language" }),
      "bg",
    );
    expect(
      screen.getByRole("searchbox", { name: "Намери приключение" }),
    ).toHaveValue("First");
    expect(screen.getByRole("link", { name: "Играй: First" })).toBeVisible();
    expect(screen.getByText("Story First")).toBeVisible();
  });
  it("shows catalog and aggregate failures explicitly without substituting invented zeros", async () => {
    failStats = true;
    failCatalog = true;
    render(<App apiUrl="https://api.test" />);
    await screen.findAllByRole("alert");
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Play: First" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });
});
