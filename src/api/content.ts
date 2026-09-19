import { request } from "./client";
export interface Submission {
  readonly id: string;
  readonly kind: "url" | "pasted";
  readonly label: string;
  readonly url?: string;
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly campaignCount?: number;
  readonly extensionCount?: number;
  readonly status: "pending" | "approved" | "rejected";
  readonly visibility: "private" | "public";
  readonly reviewNote?: string;
  readonly quarantineReason?: string;
}
export interface SubmissionResult {
  refresh?: { ok: boolean; error?: string };
  source?: { label?: string; lastError?: string };
}
export const getMyContent = (url?: string, signal?: AbortSignal) =>
  request<{ submissions: readonly Submission[] }>(url, "/api/content/mine", {
    signal,
  });
export const submitContent = (url: string | undefined, body: unknown) =>
  request<SubmissionResult>(url, "/api/content", { method: "POST", body });
export const requestPublication = (url: string | undefined, id: string) =>
  request(url, `/api/content/${encodeURIComponent(id)}/publish`, {
    method: "POST",
  });
export const deleteContent = (url: string | undefined, id: string) =>
  request(url, `/api/content/${encodeURIComponent(id)}`, { method: "DELETE" });
