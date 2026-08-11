import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPanel } from "./AccountPanel";
import type { Identity } from "./identity";

const identity: Identity = {
  playerId: "player-1",
  kind: "member",
  displayName: "Admin player",
  signInProvider: "oidc",
};

function renderPanel(): void {
  render(
    <AccountPanel
      apiUrl="https://api.example.test"
      identity={identity}
      loading={false}
      authError={null}
      onChanged={() => {}}
      profileAvailable
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountPanel admin link", () => {
  it("shows Admin beside the account control for an authorized session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ isAdmin: true }))),
      ),
    );

    renderPanel();

    expect(await screen.findByRole("link", { name: "Admin" })).toHaveAttribute(
      "href",
      "/?admin",
    );
  });

  it("hides Admin for a non-admin session", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ isAdmin: false }))),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("link", { name: "Admin" }),
    ).not.toBeInTheDocument();
  });
});
