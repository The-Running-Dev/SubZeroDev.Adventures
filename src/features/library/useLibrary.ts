import { useQuery } from "@tanstack/react-query";
import type { SaveSummary } from "@the-running-dev/game-engine";
import { useAccount } from "../../app/providers/AccountProvider";
import { getCampaigns } from "../../api/campaigns";
import { getBadges, getProgress } from "../../api/progress";
import { getPlatformStats } from "../../api/stats";
import { request } from "../../api/client";

export function useLibrary() {
  const account = useAccount();
  const { apiUrl, identity, refreshToken, loading } = account;
  const key = ["private", apiUrl, identity.playerId, refreshToken];
  const owned = Boolean(apiUrl && identity.playerId) && !loading;
  const catalog = useQuery({
    queryKey: [...key, "campaigns"],
    queryFn: async ({ signal }) => {
      if (apiUrl) return getCampaigns(apiUrl, signal);
      // Development fixtures only. Deployed builds always configure the API.
      const { createBrowserDemo } = await import("../../play/composition");
      return { campaigns: (await createBrowserDemo()).catalog };
    },
    enabled: !loading,
  });
  const progress = useQuery({
    queryKey: [...key, "progress"],
    queryFn: ({ signal }) => getProgress(apiUrl, signal),
    enabled: owned,
  });
  const saves = useQuery({
    queryKey: [...key, "saves"],
    queryFn: ({ signal }) =>
      request<{ saves: SaveSummary[] }>(apiUrl, "/api/saves", { signal }),
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
