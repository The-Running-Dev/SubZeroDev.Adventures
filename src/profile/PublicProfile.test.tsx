import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicProfile } from "./PublicProfile";
import { profileRankFor } from "../play/badges";
import type { PublicProfileData } from "../play/identity";

const emptyRecords: PublicProfileData["records"] = {
  longestRun: 0,
  longestStreak: 0,
  mostMovesInADay: 0,
  favoriteDisk: null,
  mostRejectedMoves: 0,
  fastestEnding: null,
  rarestEnding: null,
  completionRate: 0,
  attemptEfficiency: 0,
};

const sampleProfile: PublicProfileData = {
  displayName: "Test Operator",
  joinedAt: "2026-01-01T00:00:00.000Z",
  sessionsStarted: 4,
  sessionsFinished: 2,
  campaignsPlayed: 2,
  campaignsTotal: 9,
  stepsTaken: 120,
  endingsFound: 1,
  achievementsUnlocked: 1,
  badges: [
    { badgeId: "first-steps", unlockedAt: "2026-01-02T00:00:00.000Z" },
    {
      badgeId: "some-future-badge-this-client-does-not-know",
      unlockedAt: "2026-01-03T00:00:00.000Z",
    },
  ],
  records: emptyRecords,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch(profileStatus: number, profileBody: unknown) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/campaigns")) {
      return new Response(JSON.stringify({ campaigns: [] }), { status: 200 });
    }
    if (url.includes("/api/profile/")) {
      return new Response(JSON.stringify(profileBody), {
        status: profileStatus,
      });
    }
    throw new Error(`Unstubbed fetch: ${url}`);
  }) as typeof fetch;
}

describe("PublicProfile", () => {
  it("shows the unavailable message in local mode (no apiUrl)", () => {
    render(<PublicProfile slug="abc123" />);
    expect(
      screen.getByText("Profiles aren't available on this build."),
    ).toBeVisible();
  });

  it("shows a loading state, then the loaded profile", async () => {
    stubFetch(200, sampleProfile);
    render(<PublicProfile apiUrl="http://localhost:8787" slug="abc123" />);

    expect(screen.getByText("Loading operator record…")).toBeVisible();
    expect(await screen.findByText("Test Operator")).toBeVisible();
  });

  it("shows the not-found message on a 404", async () => {
    stubFetch(404, { error: { operation: "profile", code: "not_found" } });
    render(<PublicProfile apiUrl="http://localhost:8787" slug="missing" />);

    expect(
      await screen.findByText(/No public profile at this link/),
    ).toBeVisible();
  });

  it("renders the rank badge matching profileRankFor for the returned badge count", async () => {
    stubFetch(200, sampleProfile);
    render(<PublicProfile apiUrl="http://localhost:8787" slug="abc123" />);

    await screen.findByText("Test Operator");
    const rank = profileRankFor(sampleProfile.badges.length);
    expect(screen.getByText(rank.label)).toBeVisible();
  });

  it("ignores an unrecognized badge id rather than crashing", async () => {
    stubFetch(200, sampleProfile);
    render(<PublicProfile apiUrl="http://localhost:8787" slug="abc123" />);

    await screen.findByText("Test Operator");
    await waitFor(() => {
      expect(document.querySelectorAll(".badge").length).toBeGreaterThan(0);
    });
    // The known badge renders; the unrecognized id contributes no extra tile beyond
    // the fixed BADGE_ORDER set.
    expect(screen.getByText("First Steps")).toBeVisible();
  });
});
