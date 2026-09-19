import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "../test/render";
import { PublicProfile } from "./PublicProfile";
import { OwnProfile } from "./OwnProfile";
import { MyContent } from "../content/MyContent";
import { Discussions } from "../discussions/Discussions";
import { StartPage } from "../start/StartPage";

const apiUrl = "https://api.invalid";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function stub(respond: (path: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/me")
        return Response.json({
          kind: "member",
          playerId: "member-1",
          displayName: "Authored Name",
          signInProvider: null,
        });
      if (path.includes("/api/admin/"))
        return Response.json({ isAdmin: false });
      if (path === "/api/campaigns") return Response.json({ campaigns: [] });
      return respond(path, init);
    }),
  );
}
function switchLanguage() {
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
    target: { value: "bg" },
  });
}
it("keeps a public-profile server failure distinct from private or missing, and retries", async () => {
  let count = 0;
  stub(() => {
    count++;
    return Response.json({}, { status: count === 1 ? 500 : 404 });
  });
  render(<PublicProfile apiUrl={apiUrl} slug="someone" />);
  expect(await screen.findByRole("alert")).not.toHaveTextContent(
    "No public profile",
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByText(/No public profile at this link/),
  ).toBeVisible();
});
it("never displays failed private progress as a zeroed record", async () => {
  stub((path) =>
    path === "/api/progress"
      ? Response.json({}, { status: 500 })
      : path === "/api/profile/settings"
        ? Response.json({ public: false, slug: null })
        : Response.json({ badges: [], records: null }),
  );
  render(<OwnProfile apiUrl={apiUrl} />);
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByText("Stories started")).toBeNull();
});
it("keeps a content draft and validation notice through a language switch without submitting malformed JSON", async () => {
  stub(() => Response.json({ submissions: [] }));
  render(<MyContent apiUrl={apiUrl} />);
  const input = await screen.findByRole("textbox", {
    name: "Paste a campaign or extension",
  });
  fireEvent.change(input, { target: { value: "{broken" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Add" })[1]!);
  expect(await screen.findByText("This is not valid JSON.")).toBeVisible();
  switchLanguage();
  expect(await screen.findByText("Това не е валиден JSON.")).toBeVisible();
  expect(input).toHaveValue("{broken");
  expect(
    vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST"),
  ).toBe(false);
});
it("preserves discussion text and translates an existing failed-post notice", async () => {
  stub((_path, init) =>
    init?.method === "POST"
      ? Response.json({ error: { code: "too_many_requests" } }, { status: 429 })
      : Response.json({
          configured: true,
          canPost: true,
          threads: [],
          forum: "github",
        }),
  );
  render(<Discussions apiUrl={apiUrl} />);
  const title = await screen.findByRole("textbox", { name: "Title" });
  fireEvent.change(title, { target: { value: "Authored title" } });
  fireEvent.change(
    screen.getByRole("textbox", { name: "What's on your mind?" }),
    { target: { value: "Authored prose" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Post" }));
  await screen.findByText("Too many requests. Try again shortly.");
  switchLanguage();
  expect(
    await screen.findByText("Твърде много заявки. Опитай отново след малко."),
  ).toBeVisible();
  expect(title).toHaveValue("Authored title");
  expect(
    screen.getByRole("textbox", { name: "Какво искаш да споделиш?" }),
  ).toHaveValue("Authored prose");
});
it("switches the current onboarding step in place", async () => {
  render(<StartPage />);
  fireEvent.click(screen.getByRole("button", { name: /Play a campaign/ }));
  fireEvent.click(screen.getByRole("button", { name: "ENTER CONTINUE" }));
  switchLanguage();
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Прочети и избери" }),
    ).toBeVisible(),
  );
  expect(screen.getByText("СТЪПКА 2 / 3 · 67%")).toBeVisible();
});
