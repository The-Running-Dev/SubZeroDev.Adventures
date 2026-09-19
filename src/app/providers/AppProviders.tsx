import { ApiProvider } from "./ApiProvider";
import { QueryProvider } from "./QueryProvider";
import { LocaleProvider } from "./LocaleProvider";
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
    <ApiProvider url={apiUrl}>
      <QueryProvider>
        <LocaleProvider>
          <ThemeProvider>
            <AccountProvider>{children}</AccountProvider>
          </ThemeProvider>
        </LocaleProvider>
      </QueryProvider>
    </ApiProvider>
  );
}
