import { describe, expect, it } from "vitest";
import { BADGE_DEFINITIONS, BADGE_ORDER, profileRankFor } from "./badges";

describe("client badge copy", () => {
  it("has a definition for every id, and no orphans", () => {
    expect(BADGE_ORDER.length).toBe(Object.keys(BADGE_DEFINITIONS).length);
    for (const id of BADGE_ORDER) {
      expect(BADGE_DEFINITIONS[id]).toBeDefined();
    }
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

  it("returns the top rank once every badge is earned, and stays there past it", () => {
    expect(profileRankFor(BADGE_ORDER.length).label).toBe("Ran Out Of Badges");
    expect(profileRankFor(BADGE_ORDER.length + 10).label).toBe(
      "Ran Out Of Badges",
    );
  });
});
