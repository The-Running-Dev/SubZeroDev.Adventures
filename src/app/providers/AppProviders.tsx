import type { ReactNode } from "react";
import { AccountProvider } from "./AccountProvider";
import { ThemeProvider } from "./ThemeProvider";

export function AppProviders({
  apiUrl,
  children,
}: {
  apiUrl?: string;
  children: ReactNode;
}) {
  return (
    <ThemeProvider>
      <AccountProvider apiUrl={apiUrl}>{children}</AccountProvider>
    </ThemeProvider>
  );
}
