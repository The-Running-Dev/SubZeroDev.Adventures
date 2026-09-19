import { request } from "./client";
import type { BrowserCampaign } from "../play/composition";
/** Viewer-specific metadata. Never use as a public/offline catalog. */
export const getCampaigns = (url?: string, signal?: AbortSignal) =>
  request<{ campaigns: readonly BrowserCampaign[] }>(url, "/api/campaigns", {
    signal,
  });
