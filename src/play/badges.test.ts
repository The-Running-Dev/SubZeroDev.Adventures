import { describe, expect, it } from "vitest";
import {
  BADGE_DEFINITIONS,
  BADGE_ORDER,
  CROWN_BADGE_ID,
  EARNABLE_BADGE_IDS,
  playEarnedBadgeCount,
  profileRankFor,
} from "./badges";

describe("client badge copy", () => {
  it("has a definition for every id, and no orphans", () => {
    expect(BADGE_ORDER.length).toBe(Object.keys(BADGE_DEFINITIONS).length);
    for (const id of BADGE_ORDER) {
      expect(BADGE_DEFINITIONS[id]).toBeDefined();
    }
  });

  it("carries the crown in BADGE_ORDER but excludes it from EARNABLE_BADGE_IDS", () => {
    expect(BADGE_ORDER).toContain(CROWN_BADGE_ID);
    expect(EARNABLE_BADGE_IDS).not.toContain(CROWN_BADGE_ID);
    expect(EARNABLE_BADGE_IDS.length).toBe(BADGE_ORDER.length - 1);
  });
});

describe("playEarnedBadgeCount", () => {
  it("counts every held badge except the crown", () => {
    expect(
      playEarnedBadgeCount([
        { badgeId: "first-steps" },
        { badgeId: "marathoner" },
      ]),
    ).toBe(2);
    expect(
      playEarnedBadgeCount([
        { badgeId: "first-steps" },
        { badgeId: CROWN_BADGE_ID },
      ]),
    ).toBe(1);
    expect(playEarnedBadgeCount([])).toBe(0);
  });
});

describe("profileRankFor", () => {
  it("returns the bottom rank at zero badges, and just below each boundary", () => {
    expect(profileRankFor(0).label).toBe("Untitled Guest");
    expect(profileRankFor(1).label).toBe("Untitled Guest");
  });

  it("steps up exactly at each tier boundary", () => {
    expect(profileRankFor(2).label).toBe("Technically Playing");
    expect(profileRankFor(5).label).toBe("Technically Playing");
    expect(profileRankFor(6).label).toBe("Making a Habit of It");
    expect(profileRankFor(11).label).toBe("Making a Habit of It");
    expect(profileRankFor(12).label).toBe("Certified Adventurer");
    expect(profileRankFor(17).label).toBe("Certified Adventurer");
    expect(profileRankFor(18).label).toBe("Seasoned Operator");
    expect(profileRankFor(23).label).toBe("Seasoned Operator");
    expect(profileRankFor(24).label).toBe("Overachiever");
    expect(profileRankFor(29).label).toBe("Overachiever");
    expect(profileRankFor(30).label).toBe("Terminal Legend");
  });

  it("returns the top rank once every earnable badge is held, and stays there past it", () => {
    expect(profileRankFor(EARNABLE_BADGE_IDS.length).label).toBe(
      "Ran Out Of Badges",
    );
    expect(profileRankFor(EARNABLE_BADGE_IDS.length + 10).label).toBe(
      "Ran Out Of Badges",
    );
  });

  it("does not demote a player holding every earnable badge just for lacking the crown", () => {
    // The regression this guards: keying the top tier off BADGE_ORDER.length (40) instead
    // of EARNABLE_BADGE_IDS.length (39) would move this boundary and fail this assertion.
    expect(profileRankFor(EARNABLE_BADGE_IDS.length).label).toBe(
      "Ran Out Of Badges",
    );
  });
});
