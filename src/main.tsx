import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./themes.css";
import "./index.css";
import "./play/play.css";
import PlayApp from "./play/PlayApp";
import { OAuthConsent } from "./oauth/OAuthConsent";

// No router in this app -- `/oauth/consent` is the one other path it knows about, the
// authorization UI a configured Supabase project's OAuth 2.1 Server redirects to
// (OAuthConsent.tsx). index.html's inline script restores this pathname before this file
// runs, undoing the GitHub Pages 404 detour (public/404.html) for a direct navigation here.
const isOAuthConsent = window.location.pathname === "/oauth/consent";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isOAuthConsent ? <OAuthConsent /> : <PlayApp />}</StrictMode>,
);
