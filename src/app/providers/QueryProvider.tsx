import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
          },
          // The posture any mutation added later inherits: fail visibly offline, never
          // silently resume a queued action. Nothing routes through it yet -- every write
          // in the tree today is a plain async call against `api/client.ts`, which does not
          // retry either, so the two agree rather than one covering for the other.
          mutations: { retry: false, networkMode: "always" },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
