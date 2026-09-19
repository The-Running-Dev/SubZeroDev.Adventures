import type { SaveSummary } from "@the-running-dev/game-engine";
import { request } from "./client";
/** The player's own saves, newest first -- the server sorts, callers must not re-sort blind. */
export const getSaves = (url?: string, signal?: AbortSignal) =>
  request<{ saves: SaveSummary[] }>(url, "/api/saves", { signal });
