import { request } from "./client";
import type { ProfileSettings, PublicProfileData } from "../play/identity";
export const getProfile = (
  url: string | undefined,
  slug: string,
  signal?: AbortSignal,
) =>
  request<PublicProfileData>(url, `/api/profile/${encodeURIComponent(slug)}`, {
    public: true,
    signal,
  });
export const getProfileSettings = (url?: string, signal?: AbortSignal) =>
  request<ProfileSettings>(url, "/api/profile/settings", { signal });
export const setProfileVisibility = (url: string | undefined, value: boolean) =>
  request<ProfileSettings>(url, "/api/profile/visibility", {
    method: "POST",
    body: { public: value },
  });
