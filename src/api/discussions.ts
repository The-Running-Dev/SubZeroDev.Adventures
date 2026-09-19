import { request } from "./client";
import type {
  DiscussionListData,
  DiscussionThreadData,
} from "../play/identity";
export const getDiscussions = (
  url?: string,
  cursor?: string,
  signal?: AbortSignal,
) =>
  request<DiscussionListData>(
    url,
    `/api/discussions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    { signal },
  );
export const getDiscussion = (
  url: string | undefined,
  id: string,
  signal?: AbortSignal,
) =>
  request<DiscussionThreadData>(
    url,
    `/api/discussions/${encodeURIComponent(id)}`,
    { signal },
  );
export const postDiscussion = (
  url: string | undefined,
  title: string,
  body: string,
) =>
  request(url, "/api/discussions", { method: "POST", body: { title, body } });
