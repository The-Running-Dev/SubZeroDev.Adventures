import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import PlayApp from "../PlayApp";
import {
  reachEnded,
  reachPersistenceWarning,
  reachPlaying,
  reachRejected,
  reachUnavailableChoice,
} from "./fixtures";

/**
 * W65.4: an automated accessibility scan runs against the shelf, briefing,
 * playing, unavailable-choice, rejected, and ended states, and fails the
 * build on a violation. Every state is reached by driving the real, shipped
 * `PlayApp` through a real campaign (`./fixtures`) -- never a fixture
 * standing in for the rendered UI.
 */

async function scanForViolations(container: Element): Promise<void> {
  const results = await axe.run(container, { resultTypes: ["violations"] });
  expect(
    results.violations,
    results.violations
      .map((v) => `${v.id}: ${v.description} (${v.nodes.length} node(s))`)
      .join("\n"),
  ).toEqual([]);
}

describe("accessibility (W65.4)", () => {
  it("shelf", async () => {
    const { container } = render(<PlayApp />);
    await screen.findByRole("heading", { level: 1 });
    await scanForViolations(container);
  });

  it("briefing", async () => {
    const user = userEvent.setup();
    const { container } = render(<PlayApp />);
    await user.click(
      await screen.findByRole("button", { name: /The Bureaucracy/i }),
    );
    await scanForViolations(container);
  });

  it("playing", async () => {
    const { container } = await reachPlaying();
    await scanForViolations(container);
  });

  it("unavailable-choice", async () => {
    const { container } = await reachUnavailableChoice();
    const unavailable = screen.getByRole("button", {
      name: "The Platform Bet",
    });
    expect(unavailable).toBeDisabled();
    await screen.findByText("Unavailable: This ending needs more preparation.");
    await scanForViolations(container);
  });

  it("rejected", async () => {
    const { container } = await reachRejected();
    await scanForViolations(container);
  });

  it("ended", async () => {
    const { container } = await reachEnded();
    await scanForViolations(container);
  });

  it("persistence-warning", async () => {
    const { container, restore } = await reachPersistenceWarning();
    try {
      await scanForViolations(container);
    } finally {
      restore();
    }
  });
});
