import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../app/providers/AccountProvider";
import { getCampaigns, getPublicCampaigns } from "./campaigns";

/**
 * The signed-in viewer's catalog, including their own private submissions. Account-scoped,
 * so it is purged and refetched across an account transition (AccountProvider).
 *
 * The one owner of the `…"campaigns"` cache key. A second hook declaring the same key with a
 * different `queryFn` would leave which one runs down to mount order, so anything needing the
 * catalog calls this -- including the fixture fallback, which belongs to the key, not a screen.
 */
export function useCampaigns(apiUrl?: string) {
  const { identity, refreshToken, loading } = useAccount();
  return useQuery({
    queryKey: ["private", apiUrl, identity.playerId, refreshToken, "campaigns"],
    queryFn: async ({ signal }) => {
      if (apiUrl) return getCampaigns(apiUrl, signal);
      // Development fixtures only. Deployed builds always configure the API.
      const { createBrowserDemo } = await import("../play/composition");
      return { campaigns: (await createBrowserDemo()).catalog };
    },
    enabled: !loading,
  });
}

/** The anonymous catalog, for pages a stranger renders. Not keyed by player and not gated
 *  on identity, so it neither varies by viewer nor waits on `/api/me`. */
export function usePublicCampaigns(apiUrl?: string) {
  return useQuery({
    queryKey: ["public", apiUrl, "campaigns"],
    queryFn: ({ signal }) => getPublicCampaigns(apiUrl, signal),
    enabled: Boolean(apiUrl),
  });
}
