import { useQuery } from "@tanstack/react-query";
import { useAccount } from "../app/providers/AccountProvider";
import { getBadges, getProgress } from "../api/progress";
import { useCampaigns } from "../api/queries";
import { useProfileSettings } from "../play/identity";

/** Preserve failures independently from a legitimately empty player record. */
export function useProfileData(apiUrl?: string) {
  const account = useAccount();
  const key = [
    "private",
    apiUrl,
    account.identity.playerId,
    account.refreshToken,
  ];
  const enabled =
    Boolean(apiUrl && account.identity.playerId) && !account.loading;
  const progress = useQuery({
    queryKey: [...key, "progress"],
    queryFn: ({ signal }) => getProgress(apiUrl, signal),
    enabled,
  });
  const badges = useQuery({
    queryKey: [...key, "badges"],
    queryFn: ({ signal }) => getBadges(apiUrl, signal),
    enabled,
  });
  const catalog = useCampaigns(apiUrl);
  const profile = useProfileSettings(
    apiUrl,
    account.identity.playerId,
    account.refreshToken,
  );
  return { account, progress, badges, catalog, profile };
}
