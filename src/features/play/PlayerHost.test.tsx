import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../app/App";
import { AppProviders } from "../../app/providers/AppProviders";
import { AppShell } from "../../app/AppShell";
import { useAccount } from "../../app/providers/AccountProvider";
import { MemoryRouter, Route, Routes } from "react-router";

const fixtures = import.meta.glob("../../../public/campaigns/*.json", {
  eager: true,
  import: "default",
});
beforeEach(() => {
  localStorage.setItem("subzerodev.play.onboarding-seen.v1", "1");
  localStorage.setItem("subzerodev.play.theme.v1", "dos");
  window.history.replaceState({}, "", "/play/bulgaria-bureaucracy");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const name = String(input).split("/campaigns/")[1];
      if (name)
        return Response.json(fixtures[`../../../public/campaigns/${name}`]);
      throw new Error(`Unexpected request ${String(input)}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

it("retains the same scene and save while navigating to the library and back, including locale changes", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole(
    "button",
    { name: /Wait for the municipal registry/ },
    { timeout: 5000 },
  );
  await user.click(
    screen.getByRole("button", { name: /Wait for the municipal registry/ }),
  );
  await screen.findByText("GAME SAVED");
  const scene = document.querySelector(".scene-region");
  const text = scene?.querySelector(".scene-body")?.textContent;
  const saveId = localStorage.getItem(
    "subzerodev.play.save.v1.index.bulgaria-bureaucracy",
  );
  expect(saveId).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Disk library" }));
  await screen.findByRole("heading", {
    name: "Your next bad decision awaits.",
  });
  expect(scene).not.toBeVisible();
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Language" }),
    "bg",
  );
  await user.click(screen.getByRole("link", { name: "Обратно към играта" }));
  await waitFor(() => expect(scene).toBeVisible());
  expect(document.querySelector(".scene-region")).toBe(scene);
  expect(scene?.querySelector(".scene-body")?.textContent).toBe(text);
  expect(
    localStorage.getItem("subzerodev.play.save.v1.index.bulgaria-bureaucracy"),
  ).toBe(saveId);
  expect(window.location.pathname).toBe("/play/bulgaria-bureaucracy");
  await act(async () => window.history.back());
  await screen.findByRole("heading", {
    name: "Следващото ти лошо решение те чака.",
  });
  await act(async () => window.history.forward());
  await waitFor(() => expect(scene).toBeVisible());
  expect(document.querySelector(".scene-region")).toBe(scene);
});

it("resumes the committed save after a full app remount", async () => {
  const user = userEvent.setup();
  const app = render(<App />);
  await user.click(
    await screen.findByRole("button", {
      name: /Wait for the municipal registry/,
    }),
  );
  await screen.findByText("GAME SAVED");
  const text = document.querySelector(".scene-body")?.textContent;
  app.unmount();
  render(<App />);
  await waitFor(() =>
    expect(document.querySelector(".scene-body")?.textContent).toBe(text),
  );
  expect(window.location.pathname).toBe("/play/bulgaria-bureaucracy");
});

it("redirects a legacy campaign URL without leaving an extra history entry", async () => {
  window.history.replaceState(
    {},
    "",
    "/?campaign=bulgaria-bureaucracy&source=shared",
  );
  render(<App />);
  await screen.findByRole(
    "button",
    { name: /Wait for the municipal registry/ },
    { timeout: 5000 },
  );
  expect(window.location.pathname).toBe("/play/bulgaria-bureaucracy");
  expect(window.location.search).toBe("?source=shared");
});

it("reports an unknown campaign without starting onboarding or a different story", async () => {
  window.history.replaceState({}, "", "/play/not-a-campaign");
  localStorage.removeItem("subzerodev.play.onboarding-seen.v1");
  render(<App />);
  await screen.findByRole("heading", { name: "Adventure unavailable" });
  expect(document.querySelector(".scene-region")).toBeNull();
  expect(localStorage.getItem("subzerodev.play.onboarding-seen.v1")).toBeNull();
});

function ResetIdentity() {
  const { refreshIdentity } = useAccount();
  return <button onClick={() => refreshIdentity()}>Reset identity</button>;
}
it("discards the mounted player when the account generation changes", async () => {
  const user = userEvent.setup();
  render(
    <AppProviders>
      <MemoryRouter initialEntries={["/play/bulgaria-bureaucracy"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="play/:campaignId" element={<ResetIdentity />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
  await screen.findByText("GAME SAVED", {}, { timeout: 5000 });
  const scene = document.querySelector(".scene-region");
  await user.click(screen.getByRole("button", { name: "Reset identity" }));
  await screen.findByText("GAME SAVED", {}, { timeout: 5000 });
  expect(scene).not.toBeInTheDocument();
  expect(document.querySelector(".scene-region")).not.toBe(scene);
});
