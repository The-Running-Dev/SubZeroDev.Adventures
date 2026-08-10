import { describe, expect, it } from "vitest";
import { BADGE_DEFINITIONS, CROWN_BADGE_ID } from "./badges";
import { positionTitleFor } from "./ranking";

describe("positionTitleFor", () => {
  it("steps down through every band boundary", () => {
    expect(positionTitleFor(1).label).toBe("Interim Head of Absurdity");
    expect(positionTitleFor(2).label).toBe("Deputy Nuisance");
    expect(positionTitleFor(3).label).toBe("Deputy Nuisance");
    expect(positionTitleFor(4).label).toBe("Senior Complication");
    expect(positionTitleFor(10).label).toBe("Senior Complication");
    expect(positionTitleFor(11).label).toBe("Person of Interest");
    expect(positionTitleFor(25).label).toBe("Person of Interest");
    expect(positionTitleFor(26).label).toBe("Registered Operator");
    expect(positionTitleFor(50).label).toBe("Registered Operator");
    expect(positionTitleFor(51).label).toBe("Filed Under Other");
    expect(positionTitleFor(5000).label).toBe("Filed Under Other");
  });

  it("clamps zero and negative positions to band 1 rather than throwing", () => {
    expect(positionTitleFor(0).label).toBe("Interim Head of Absurdity");
    expect(positionTitleFor(-5).label).toBe("Interim Head of Absurdity");
  });

  it("position 1's label matches the crown badge's own label", () => {
    expect(positionTitleFor(1).label).toBe(
      BADGE_DEFINITIONS[CROWN_BADGE_ID]!.label,
    );
  });
});
