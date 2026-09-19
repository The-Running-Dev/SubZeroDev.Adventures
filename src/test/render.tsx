import {
  render as renderReact,
  type RenderOptions,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ReactElement } from "react";
import { AppProviders } from "../app/providers/AppProviders";
import { AppShell } from "../app/AppShell";

/** Component suites mount the same providers/chrome as production. */
export function render(
  ui: ReactElement<{ apiUrl?: string }>,
  options?: RenderOptions,
) {
  const pageNames = [
    "PlayApp",
    "StartPage",
    "Ranking",
    "OwnProfile",
    "PublicProfile",
    "MyContent",
    "Discussions",
  ];
  const name = typeof ui.type === "function" ? ui.type.name : "";
  const isPage = pageNames.includes(name);
  const path =
    (
      {
        StartPage: "/start",
        Ranking: "/ranking",
        OwnProfile: "/profile",
        MyContent: "/content",
        Discussions: "/discussions",
      } as Record<string, string>
    )[name] ?? window.location.pathname;
  return renderReact(ui, {
    wrapper: ({ children }) => (
      <AppProviders apiUrl={ui.props.apiUrl}>
        <MemoryRouter initialEntries={[path + window.location.search]}>
          {isPage ? (
            <Routes>
              <Route element={<AppShell />}>
                <Route path="*" element={children} />
              </Route>
            </Routes>
          ) : (
            children
          )}
        </MemoryRouter>
      </AppProviders>
    ),
    ...options,
  });
}
