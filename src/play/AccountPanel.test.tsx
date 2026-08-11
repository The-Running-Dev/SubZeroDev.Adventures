import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountPanel } from "./AccountPanel";
import type { Identity } from "./identity";

const identity: Identity = {
  playerId: "player-1",
  kind: "member",
  displayName: "Admin player",
  signInProvider: "oidc",
};

function renderPanel(isAdmin: boolean): void {
  render(
    <AccountPanel
      apiUrl="https://api.example.test"
      identity={identity}
      loading={false}
      authError={null}
      onChanged={() => {}}
      isAdmin={isAdmin}
      profileAvailable
    />,
  );
}

describe("AccountPanel admin link", () => {
  it("shows Admin beside the account control for an authorized session", async () => {
    renderPanel(true);

    expect(await screen.findByRole("link", { name: "Admin" })).toHaveAttribute(
      "href",
      "/?admin",
    );
  });

  it("hides Admin for a non-admin session", async () => {
    renderPanel(false);

    expect(
      screen.queryByRole("link", { name: "Admin" }),
    ).not.toBeInTheDocument();
  });
});
