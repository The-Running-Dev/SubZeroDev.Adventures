import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../../app/providers/AccountProvider";
import { useCampaigns } from "../../api/queries";
import { getBadges, getProgress } from "../../api/progress";
import { getSaves } from "../../api/saves";
import { getPlatformStats } from "../../api/stats";

export function useLibrary() {
  const account = useAccount();
  const { apiUrl, identity, refreshToken, loading } = account;
  const key = ["private", apiUrl, identity.playerId, refreshToken];
  const owned = Boolean(apiUrl && identity.playerId) && !loading;
  const catalog = useCampaigns(apiUrl);
  const progress = useQuery({
    queryKey: [...key, "progress"],
    queryFn: ({ signal }) => getProgress(apiUrl, signal),
    enabled: owned,
  });
  const saves = useQuery({
    queryKey: [...key, "saves"],
    queryFn: ({ signal }) => getSaves(apiUrl, signal),
    enabled: owned,
  });
  const badges = useQuery({
    queryKey: [...key, "badges"],
    queryFn: ({ signal }) => getBadges(apiUrl, signal),
    enabled: owned,
  });
  const stats = useQuery({
    queryKey: ["public", apiUrl, "stats"],
    queryFn: ({ signal }) => getPlatformStats(apiUrl, signal),
    enabled: Boolean(apiUrl),
  });
  return { account, catalog, progress, saves, badges, stats };
}
