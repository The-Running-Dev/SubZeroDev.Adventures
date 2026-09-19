import { Suspense, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { Header } from "../Header";
import { AccountPanel } from "../play/AccountPanel";
import { MatrixRain } from "../play/MatrixRain";
import { useAccount } from "./providers/AccountProvider";
import { useTheme } from "./providers/ThemeProvider";
import { PlayerShellContext, type PlayerShellState } from "./playerShell";
import { ErrorBoundary } from "./ErrorBoundary";

export function AppShell() {
  const location = useLocation();
  const { theme, changeTheme } = useTheme();
  const account = useAccount();
  const [player, setPlayer] = useState<PlayerShellState | null>(null);
  const current =
    location.pathname === "/ranking"
      ? "standings"
      : location.pathname === "/content"
        ? "content"
        : location.pathname === "/start"
          ? "start"
          : location.pathname.startsWith("/discussions")
            ? "discussions"
            : location.pathname === "/profile" ||
                location.pathname.startsWith("/u/")
              ? "profile"
              : player?.title
                ? "playing"
                : "shelf";
  return (
    <PlayerShellContext.Provider value={setPlayer}>
      {theme === "matrix" && <MatrixRain />}
      <main
        className={player?.hidden ? "play-main onboarding-active" : "play-main"}
      >
        <Header
          hidden={player?.hidden}
          current={current}
          playingTitle={player?.title}
          onSelectShelf={player?.onSelectShelf}
          theme={theme}
          onThemeChange={changeTheme}
        >
          {account.apiUrl && (
            <AccountPanel
              apiUrl={account.apiUrl}
              identity={account.identity}
              loading={account.loading}
              authError={account.authError}
              onChanged={account.refreshIdentity}
              isAdmin={account.isAdmin}
              profileAvailable={
                location.pathname !== "/profile" &&
                account.identity.kind !== "anonymous"
              }
            />
          )}
        </Header>
        <ErrorBoundary key={location.pathname + location.search}>
          <Suspense
            fallback={
              <div className="play-loading" role="status">
                Loading screen…
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </PlayerShellContext.Provider>
  );
}
