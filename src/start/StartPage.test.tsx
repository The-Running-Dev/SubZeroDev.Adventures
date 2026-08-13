import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { StartPage } from "./StartPage";
import { PATHS } from "./content";

describe("StartPage", () => {
  it("opens on the fork, listing every path", async () => {
    render(<StartPage />);
    expect(
      screen.getByRole("heading", { name: "What are you here to do?" }),
    ).toBeInTheDocument();
    for (const path of PATHS) {
      expect(
        screen.getByRole("button", { name: new RegExp(path.title, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("walks a chosen path and reports real step progress", async () => {
    const user = userEvent.setup();
    render(<StartPage />);

    await user.click(screen.getByRole("button", { name: /Play a campaign/i }));
    expect(
      screen.getByRole("heading", { name: "Pick a disk" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/STEP 1 \/ 3/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ENTER CONTINUE" }));
    expect(
      screen.getByRole("heading", { name: "Read, then choose" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ESC BACK" }));
    expect(
      screen.getByRole("heading", { name: "Pick a disk" }),
    ).toBeInTheDocument();
  });

  it("stops advancing at the end of a path", async () => {
    const user = userEvent.setup();
    render(<StartPage />);
    await user.click(screen.getByRole("button", { name: /Play a campaign/i }));
    await user.click(screen.getByRole("button", { name: "ENTER CONTINUE" }));
    await user.click(screen.getByRole("button", { name: "ENTER CONTINUE" }));
    expect(screen.getByText(/STEP 3 \/ 3/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "ENTER CONTINUE" }),
    ).toBeDisabled();
  });

  it("returns to the fork from F3 MENU", async () => {
    const user = userEvent.setup();
    render(<StartPage />);
    await user.click(screen.getByRole("button", { name: /Play a campaign/i }));
    await user.click(screen.getByRole("button", { name: "F3 MENU" }));
    expect(
      screen.getByRole("heading", { name: "What are you here to do?" }),
    ).toBeInTheDocument();
  });

  it("opens the authoring wizard instead of a walkthrough", async () => {
    const user = userEvent.setup();
    render(<StartPage />);
    await user.click(screen.getByRole("button", { name: /Write a campaign/i }));
    expect(screen.getByText(/CAMPAIGN AUTHORING/)).toBeInTheDocument();
    // The authoring door is not gated on having finished a run -- the mockup locked it, this
    // page deliberately does not (see StartPage.tsx's header).
    expect(screen.queryByText(/finish a run first/i)).not.toBeInTheDocument();
  });

  it("marks itself current in the global nav", () => {
    render(<StartPage />);
    expect(
      screen.getByRole("link", { name: "Getting started" }),
    ).toHaveAttribute("aria-current", "page");
  });
});
