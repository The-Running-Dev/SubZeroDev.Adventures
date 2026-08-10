/**
 * The Supabase client backing the OAuth consent page (OAuthConsent.tsx) only -- this has
 * nothing to do with `../play/identity.ts`, which talks to this repo's own server
 * (`server/src/identity/oidc.ts`) as an OIDC *client*. Here, a Supabase project is the
 * OIDC *provider*: `/oauth/consent` is the authorization UI Supabase's OAuth 2.1 Server
 * redirects to, and this SDK is how that page authenticates the visitor against Supabase's
 * own auth and calls `approveAuthorization`/`denyAuthorization`.
 *
 * `undefined` when unconfigured (no Supabase project set up yet) rather than throwing --
 * OAuthConsent.tsx renders a "not configured" state instead of crashing the page.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | undefined =
  url && anonKey ? createClient(url, anonKey) : undefined;
