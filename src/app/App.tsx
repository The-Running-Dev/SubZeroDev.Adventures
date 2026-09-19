import { BrowserRouter } from "react-router";
import { AppProviders } from "./providers/AppProviders";
import { AppRoutes } from "./routes";
import { ErrorBoundary } from "./ErrorBoundary";

export function App({ apiUrl }: { apiUrl?: string }) {
  return (
    <ErrorBoundary>
      <AppProviders apiUrl={apiUrl}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </ErrorBoundary>
  );
}
