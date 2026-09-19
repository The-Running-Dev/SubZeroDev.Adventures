import { request } from "./client";
import type {
  Badge,
  CampaignProgress,
  PersonnelRecords,
} from "../play/identity";
export const getProgress = (url?: string, signal?: AbortSignal) =>
  request<{ progress: CampaignProgress[] }>(url, "/api/progress", { signal });
export const getBadges = (url?: string, signal?: AbortSignal) =>
  request<{ badges: Badge[]; records: PersonnelRecords | null }>(
    url,
    "/api/badges",
    { signal },
  );
