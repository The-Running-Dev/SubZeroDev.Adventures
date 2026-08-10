import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlayerHome } from "./PlayerHome";
import { BADGE_DEFINITIONS, BADGE_ORDER, profileRankFor } from "./badges";
import type {
  Badge,
  CampaignProgress,
  Identity,
  PersonnelRecords,
  ProfileSettings,
} from "./identity";
import type { BrowserCampaign } from "./composition";

const identity: Identity = {
  playerId: "player-1",
  kind: "member",
  displayName: "Test Operator",
  signInProvider: "oidc",
};

const catalog: readonly BrowserCampaign[] = [];
const progress: ReadonlyMap<string, CampaignProgress> = new Map();
const records: PersonnelRecords | null = null;
const privateSettings: ProfileSettings = { public: false, slug: null };
const publicSettings: ProfileSettings = { public: true, slug: "abc123" };

function renderHome(
  overrides: Partial<{
    identity: Identity;
    badges: readonly Badge[];
    settings: ProfileSettings;
    setPublic: (next: boolean) => Promise<void>;
  }> = {},
) {
  return render(
    <PlayerHome
      identity={overrides.identity ?? identity}
      progress={progress}
      badges={overrides.badges ?? []}
      records={records}
      catalog={catalog}
      settings={overrides.settings ?? privateSettings}
      setPublic={overrides.setPublic ?? (() => Promise.resolve())}
    />,
  );
}

describe("PlayerHome", () => {
  it("renders every known badge, earned or not", () => {
    renderHome();

    for (const id of BADGE_ORDER) {
      expect(screen.getByText(BADGE_DEFINITIONS[id]!.label)).toBeVisible();
    }
    expect(document.querySelectorAll(".badge").length).toBe(BADGE_ORDER.length);
  });

  it("marks unearned badges as locked with visible LOCKED text, never hidden", () => {
    renderHome();

    const locked = document.querySelectorAll(".badge-locked");
    expect(locked.length).toBe(BADGE_ORDER.length);
    for (const el of locked) {
      expect(el).toBeVisible();
      expect(el.textContent).toContain("LOCKED");
    }
  });

  it("marks an earned badge as unlocked, not locked, with its unlock date", () => {
    const badges: readonly Badge[] = [
      { badgeId: "first-steps", unlockedAt: "2026-01-15T00:00:00.000Z" },
    ];
    renderHome({ badges });

    const items = document.querySelectorAll(".badge");
    const earned = [...items].find((el) =>
      el.textContent?.includes("First Steps"),
    )!;
    expect(earned).not.toHaveClass("badge-locked");
    expect(earned.textContent).toContain("UNLOCKED 2026-01-15");

    expect(document.querySelectorAll(".badge-locked").length).toBe(
      BADGE_ORDER.length - 1,
    );
  });

  it("ignores an unrecognized badge id from the server rather than crashing", () => {
    const badges: readonly Badge[] = [
      {
        badgeId: "some-future-badge-this-client-does-not-know",
        unlockedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect(() => renderHome({ badges })).not.toThrow();
    // Still exactly the known set -- the unrecognized id contributes no tile.
    expect(document.querySelectorAll(".badge").length).toBe(BADGE_ORDER.length);
  });

  it("shows a guest note for a guest player, not for a member", () => {
    const { rerender } = render(
      <PlayerHome
        identity={{ ...identity, kind: "guest" }}
        progress={progress}
        badges={[]}
        records={records}
        catalog={catalog}
        settings={privateSettings}
        setPublic={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText(/Playing as a guest/)).toBeVisible();

    rerender(
      <PlayerHome
        identity={identity}
        progress={progress}
        badges={[]}
        records={records}
        catalog={catalog}
        settings={privateSettings}
        setPublic={() => Promise.resolve()}
      />,
    );
    expect(screen.queryByText(/Playing as a guest/)).not.toBeInTheDocument();
  });

  it("renders the rank badge matching profileRankFor for the given badge count", () => {
    const badges: readonly Badge[] = [
      { badgeId: "first-steps", unlockedAt: "2026-01-01T00:00:00.000Z" },
      { badgeId: "collector", unlockedAt: "2026-01-02T00:00:00.000Z" },
    ];
    renderHome({ badges });

    const rank = profileRankFor(badges.length);
    expect(screen.getByText(rank.label)).toBeVisible();
    expect(screen.getByText(rank.description)).toBeVisible();
  });

  it("shows 'Make profile public' when private, and calls setPublic(true) on click", async () => {
    const user = userEvent.setup();
    const setPublic = vi.fn(() => Promise.resolve());
    renderHome({ settings: privateSettings, setPublic });

    const button = screen.getByRole("button", { name: "Make profile public" });
    await user.click(button);
    expect(setPublic).toHaveBeenCalledWith(true);

    // No share link while private.
    expect(
      screen.queryByRole("textbox", { name: "Public profile link" }),
    ).not.toBeInTheDocument();
  });

  it("shows the share link and 'Make profile private' when public, and copies the link", async () => {
    const user = userEvent.setup();
    const setPublic = vi.fn(() => Promise.resolve());
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderHome({ settings: publicSettings, setPublic });

    const toggle = screen.getByRole("button", {
      name: "Make profile private",
    });
    await user.click(toggle);
    expect(setPublic).toHaveBeenCalledWith(false);

    const link = screen.getByRole("textbox", { name: "Public profile link" });
    expect(link).toHaveValue(`${window.location.origin}/u/abc123`);

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/u/abc123`,
    );
  });
});
