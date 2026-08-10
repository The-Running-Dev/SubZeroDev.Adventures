import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlayerHome } from "./PlayerHome";
import { BADGE_DEFINITIONS, BADGE_ORDER } from "./badges";
import type { Badge, CampaignProgress, Identity } from "./identity";
import type { BrowserCampaign } from "./composition";

const identity: Identity = {
  playerId: "player-1",
  kind: "member",
  displayName: "Test Operator",
  signInProvider: "oidc",
};

const catalog: readonly BrowserCampaign[] = [];
const progress: ReadonlyMap<string, CampaignProgress> = new Map();

describe("PlayerHome", () => {
  it("renders every known badge, earned or not", () => {
    render(
      <PlayerHome
        identity={identity}
        progress={progress}
        badges={[]}
        catalog={catalog}
      />,
    );

    for (const id of BADGE_ORDER) {
      expect(screen.getByText(BADGE_DEFINITIONS[id]!.label)).toBeVisible();
    }
    expect(document.querySelectorAll(".badge").length).toBe(BADGE_ORDER.length);
  });

  it("marks unearned badges as locked with visible LOCKED text, never hidden", () => {
    render(
      <PlayerHome
        identity={identity}
        progress={progress}
        badges={[]}
        catalog={catalog}
      />,
    );

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
    render(
      <PlayerHome
        identity={identity}
        progress={progress}
        badges={badges}
        catalog={catalog}
      />,
    );

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
    expect(() =>
      render(
        <PlayerHome
          identity={identity}
          progress={progress}
          badges={badges}
          catalog={catalog}
        />,
      ),
    ).not.toThrow();
    // Still exactly the known set -- the unrecognized id contributes no tile.
    expect(document.querySelectorAll(".badge").length).toBe(BADGE_ORDER.length);
  });

  it("shows a guest note for a guest player, not for a member", () => {
    const { rerender } = render(
      <PlayerHome
        identity={{ ...identity, kind: "guest" }}
        progress={progress}
        badges={[]}
        catalog={catalog}
      />,
    );
    expect(screen.getByText(/Playing as a guest/)).toBeVisible();

    rerender(
      <PlayerHome
        identity={identity}
        progress={progress}
        badges={[]}
        catalog={catalog}
      />,
    );
    expect(screen.queryByText(/Playing as a guest/)).not.toBeInTheDocument();
  });
});
