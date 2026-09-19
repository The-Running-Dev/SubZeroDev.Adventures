import { request } from "./client";
import type { PlatformStats } from "../play/identity";
export const getPlatformStats = (url?: string, signal?: AbortSignal) =>
  request<PlatformStats>(url, "/api/stats", { public: true, signal });
