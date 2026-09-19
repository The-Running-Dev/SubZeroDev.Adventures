import { request } from "./client";
import type { RankingData } from "../play/identity";
export const getRanking = (url?: string, signal?: AbortSignal) =>
  request<RankingData>(url, "/api/ranking", { public: true, signal });
