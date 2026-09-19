import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "../test/render";
import { LanguageSelector } from "../components/LanguageSelector";
import { OAuthConsent } from "./OAuthConsent";
const auth = vi.hoisted(() => ({
  getUser: vi.fn(),
  oauth: {
    getAuthorizationDetails: vi.fn(),
    approveAuthorization: vi.fn(),
    denyAuthorization: vi.fn(),
  },
}));
vi.mock("./supabaseClient", () => ({ supabase: { auth } }));
afterEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});
it.each(["approve", "deny"] as const)(
  "keeps the authorization request across a language switch before %s",
  async (decision) => {
    window.history.replaceState(
      {},
      "",
      "/oauth/consent?authorization_id=request-123",
    );
    auth.getUser.mockResolvedValue({ data: { user: { id: "user" } } });
    auth.oauth.getAuthorizationDetails.mockResolvedValue({
      data: {
        authorization_id: "request-123",
        client: { name: "Authored client" },
        scope: "openid profile",
      },
      error: null,
    });
    auth.oauth.approveAuthorization.mockRejectedValue(new Error("network"));
    auth.oauth.denyAuthorization.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    render(
      <>
        <LanguageSelector />
        <OAuthConsent />
      </>,
    );
    await screen.findByText(
      "Authored client wants to sign you in using this account.",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Language" }),
      "bg",
    );
    expect(screen.getByText("Поискан достъп: openid profile")).toBeVisible();
    expect(
      screen.getByText("Authored client иска да те впише с този профил."),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: decision === "approve" ? "Одобри" : "Откажи",
      }),
    );
    expect(
      auth.oauth[
        decision === "approve" ? "approveAuthorization" : "denyAuthorization"
      ],
    ).toHaveBeenCalledExactlyOnceWith("request-123");
    expect(
      auth.oauth[
        decision === "approve" ? "denyAuthorization" : "approveAuthorization"
      ],
    ).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Входът не е успешен.",
    );
    expect(auth.oauth.getAuthorizationDetails).toHaveBeenCalledTimes(1);
  },
);
