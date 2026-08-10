import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./themes.css";
import "./index.css";
import "./play/play.css";
import PlayApp from "./play/PlayApp";
import { OAuthConsent } from "./oauth/OAuthConsent";
import { PublicProfile } from "./profile/PublicProfile";

// No router in this app -- `/oauth/consent` and `/u/<slug>` are the two other paths it
// knows about: `/oauth/consent` is the authorization UI a configured Supabase project's
// OAuth 2.1 Server redirects to (OAuthConsent.tsx); `/u/<slug>` is a player's public
// profile (src/profile/PublicProfile.tsx). index.html's inline script restores the real
// pathname before this file runs, undoing the GitHub Pages 404 detour (public/404.html)
// for a direct navigation to either.
const path = window.location.pathname;
const isOAuthConsent = path === "/oauth/consent";
const profileSlug = path.match(/^\/u\/([^/]+)$/)?.[1];

// Read once, here, and passed down as a prop -- not read again inside PublicProfile --
// so that component stays testable under this repo's suite, which pins VITE_API_URL to
// "" for the whole run (vite.config.ts, issue #18) and would otherwise only ever be able
// to exercise PublicProfile's local-mode branch.
const apiUrl = import.meta.env.VITE_API_URL as string | undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isOAuthConsent ? (
      <OAuthConsent />
    ) : profileSlug ? (
      <PublicProfile apiUrl={apiUrl} slug={profileSlug} />
    ) : (
      <PlayApp />
    )}
  </StrictMode>,
);
