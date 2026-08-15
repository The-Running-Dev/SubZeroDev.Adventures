import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./themes.css";
import "./index.css";
import "./play/play.css";
import "./start/start.css";
import PlayApp from "./play/PlayApp";
import { StartPage } from "./start/StartPage";
import { OAuthConsent } from "./oauth/OAuthConsent";
import { OwnProfile } from "./profile/OwnProfile";
import { PublicProfile } from "./profile/PublicProfile";
import { Ranking } from "./ranking/Ranking";
import { MyContent } from "./content/MyContent";
import { Discussions } from "./discussions/Discussions";

// No router in this app -- `/oauth/consent`, `/ranking`, `/profile`, `/content`, `/start`,
// `/discussions`(`/<id>`), and `/u/<slug>` are the other paths it knows about:
// `/oauth/consent` is the authorization UI a configured Supabase project's OAuth 2.1
// Server redirects to (OAuthConsent.tsx); `/ranking` is the public leaderboard
// (src/ranking/Ranking.tsx); `/profile` is the signed-in player's own profile
// (src/profile/OwnProfile.tsx); `/content` is a player's own submitted
// campaigns/extensions (src/content/MyContent.tsx); `/start` is the getting-started page
// and the campaign-authoring wizard (src/start/StartPage.tsx); `/discussions` and
// `/discussions/<id>` are the operator channel over this repository's GitHub Discussions
// (src/discussions/Discussions.tsx); `/u/<slug>` is a player's public profile
// (src/profile/PublicProfile.tsx). index.html's inline script restores the real pathname
// before this file runs, undoing the GitHub Pages 404 detour (public/404.html) for a
// direct navigation to any of them.
const path = window.location.pathname;
const isOAuthConsent = path === "/oauth/consent";
const isRanking = path === "/ranking";
const isOwnProfile = path === "/profile";
const isMyContent = path === "/content";
const isStart = path === "/start";
const isDiscussions = path === "/discussions";
const discussionThreadId = path.match(/^\/discussions\/(\d+)$/)?.[1];
const profileSlug = path.match(/^\/u\/([^/]+)$/)?.[1];

// Read once, here, and passed down as a prop -- not read again inside PublicProfile or
// Ranking -- so those components stay testable under this repo's suite, which pins
// VITE_API_URL to "" for the whole run (vite.config.ts, issue #18) and would otherwise
// only ever be able to exercise their local-mode branch.
const apiUrl = import.meta.env.VITE_API_URL as string | undefined;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isOAuthConsent ? (
      <OAuthConsent />
    ) : isRanking ? (
      <Ranking apiUrl={apiUrl} />
    ) : isOwnProfile ? (
      <OwnProfile apiUrl={apiUrl} />
    ) : isMyContent ? (
      <MyContent apiUrl={apiUrl} />
    ) : isStart ? (
      <StartPage apiUrl={apiUrl} />
    ) : isDiscussions || discussionThreadId ? (
      <Discussions apiUrl={apiUrl} threadId={discussionThreadId} />
    ) : profileSlug ? (
      <PublicProfile apiUrl={apiUrl} slug={profileSlug} />
    ) : (
      <PlayApp />
    )}
  </StrictMode>,
);
