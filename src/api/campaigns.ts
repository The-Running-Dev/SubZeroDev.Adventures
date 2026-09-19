import { request } from "./client";
import type { BrowserCampaign } from "../play/composition";

/**
 * The viewer's own catalog. `/api/campaigns` filters per principal and answers
 * `Vary: Cookie` (server/src/routes/session.ts), so a credentialed read includes the
 * caller's own private submissions. Never use it as a public or offline catalog -- on a
 * page rendered for a stranger it makes the contents depend on who is looking.
 */
export const getCampaigns = (url?: string, signal?: AbortSignal) =>
  request<{ campaigns: readonly BrowserCampaign[] }>(url, "/api/campaigns", {
    signal,
  });

/**
 * The same route read anonymously. Credentials are omitted, so the server resolves no
 * principal (`resolvePrincipal` never mints one) and answers with the core catalog every
 * visitor sees -- one cache entry, identical for everyone, and no dependency on identity
 * having loaded first.
 */
export const getPublicCampaigns = (url?: string, signal?: AbortSignal) =>
  request<{ campaigns: readonly BrowserCampaign[] }>(url, "/api/campaigns", {
    signal,
    public: true,
  });
