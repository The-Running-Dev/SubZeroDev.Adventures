import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../app/providers/AccountProvider";
import { getCampaigns } from "./campaigns";

export function useCampaigns(apiUrl?: string) {
  const { identity, refreshToken, loading } = useAccount();
  return useQuery({
    queryKey: ["private", apiUrl, identity.playerId, refreshToken, "campaigns"],
    queryFn: ({ signal }) => getCampaigns(apiUrl, signal),
    enabled: Boolean(apiUrl) && !loading,
  });
}
