import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../app/providers/AccountProvider";
import { getCampaigns, getPublicCampaigns } from "./campaigns";

/** The signed-in viewer's catalog, including their own private submissions. Account-scoped,
 *  so it is purged and refetched across an account transition (AccountProvider). */
export function useCampaigns(apiUrl?: string) {
  const { identity, refreshToken, loading } = useAccount();
  return useQuery({
    queryKey: ["private", apiUrl, identity.playerId, refreshToken, "campaigns"],
    queryFn: ({ signal }) => getCampaigns(apiUrl, signal),
    enabled: Boolean(apiUrl) && !loading,
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
