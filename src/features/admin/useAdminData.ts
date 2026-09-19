import { useQuery } from "@tanstack/react-query";
import { request } from "../../api/client";
import { useAccount } from "../../app/providers/AccountProvider";
import type { AdminContentStatus, PendingSubmission } from "./types";

export function useAdminContentStatus(
  apiUrl: string | undefined,
  refresh: string,
) {
  const account = useAccount();
  const query = useQuery({
    queryKey: [
      "private",
      apiUrl,
      account.identity.playerId,
      account.refreshToken,
      "admin-status",
      refresh,
    ],
    queryFn: ({ signal }) =>
      request<AdminContentStatus>(apiUrl, "/api/admin/content/status", {
        signal,
      }),
    enabled: Boolean(apiUrl),
  });
  return {
    status: query.data,
    error: query.error ?? undefined,
    refetch: () => {
      void query.refetch();
    },
    loading: query.isPending,
  };
}
export function useSubmissionQueue(
  apiUrl: string | undefined,
  refresh: string,
) {
  const account = useAccount();
  const query = useQuery({
    queryKey: [
      "private",
      apiUrl,
      account.identity.playerId,
      account.refreshToken,
      "admin-queue",
      refresh,
    ],
    queryFn: ({ signal }) =>
      request<{ submissions: PendingSubmission[] }>(
        apiUrl,
        "/api/admin/content/submissions",
        { signal },
      ),
    enabled: Boolean(apiUrl),
  });
  return {
    submissions: query.data?.submissions ?? [],
    error: query.error ?? undefined,
    refetch: () => {
      void query.refetch();
    },
    loading: query.isPending,
  };
}
