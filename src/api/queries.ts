import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../app/providers/AccountProvider";
import { getCampaigns } from "./campaigns";

/**
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
