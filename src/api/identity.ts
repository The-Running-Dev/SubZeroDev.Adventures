import { request } from "./client";
import type { Identity } from "../play/identity";
export const getIdentity = (url?: string) => request<Identity>(url, "/api/me");
export const getAdminAccess = (url?: string, signal?: AbortSignal) =>
  request<{ isAdmin?: boolean }>(url, "/api/admin/content/status", { signal });
