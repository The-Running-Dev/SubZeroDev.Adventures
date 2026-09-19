import { useTranslation } from "react-i18next";
import { lazy } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router";
import { AppShell } from "./AppShell";
import { useAccount } from "./providers/AccountProvider";

const Library = lazy(() => import("../features/library/Library"));
const PlayApp = lazy(() => import("../play/PlayApp"));
const Ranking = lazy(() =>
  import("../ranking/Ranking").then((m) => ({ default: m.Ranking })),
);
const OwnProfile = lazy(() =>
  import("../profile/OwnProfile").then((m) => ({ default: m.OwnProfile })),
);
const PublicProfile = lazy(() =>
  import("../profile/PublicProfile").then((m) => ({
    default: m.PublicProfile,
  })),
);
const MyContent = lazy(() =>
  import("../content/MyContent").then((m) => ({ default: m.MyContent })),
);
const StartPage = lazy(() =>
  import("../start/StartPage").then((m) => ({ default: m.StartPage })),
);
const Discussions = lazy(() =>
  import("../discussions/Discussions").then((m) => ({
    default: m.Discussions,
  })),
);
const OAuthConsent = lazy(() =>
  import("../oauth/OAuthConsent").then((m) => ({ default: m.OAuthConsent })),
);

function LibraryRoute() {
  const { search } = useLocation();
  const query = new URLSearchParams(search);
  const requested = query.get("campaign");
  if (requested) {
    query.delete("campaign");
    const remainder = query.toString();
    return (
      <Navigate
        replace
        to={`/play/${encodeURIComponent(requested)}${remainder ? `?${remainder}` : ""}`}
      />
    );
  }
  return query.has("admin") ? <PlayApp /> : <Library />;
}

function ThreadRoute() {
  const { apiUrl } = useAccount();
  const { threadId } = useParams();
  return threadId && /^[A-Za-z0-9_-]{1,64}$/.test(threadId) ? (
    <Discussions apiUrl={apiUrl} threadId={threadId} />
  ) : (
    <NotFound />
  );
}

function ProfileRoute() {
  const { apiUrl } = useAccount();
  const { slug } = useParams();
  return <PublicProfile apiUrl={apiUrl} slug={slug!} />;
}

function NotFound() {
  const { t } = useTranslation("shell");
  return (
    <section className="archive">
      <h1>{t("missing")}</h1>
      <Link to="/">{t("returnLibrary")}</Link>
    </section>
  );
}

export function AppRoutes() {
  const { apiUrl } = useAccount();
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<LibraryRoute />} />
        <Route path="play/:campaignId" element={null} />
        <Route path="ranking" element={<Ranking apiUrl={apiUrl} />} />
        <Route path="profile" element={<OwnProfile apiUrl={apiUrl} />} />
        <Route path="content" element={<MyContent apiUrl={apiUrl} />} />
        <Route path="start" element={<StartPage apiUrl={apiUrl} />} />
        <Route path="discussions" element={<Discussions apiUrl={apiUrl} />} />
        <Route path="discussions/:threadId" element={<ThreadRoute />} />
        <Route path="u/:slug" element={<ProfileRoute />} />
        <Route path="oauth/consent" element={<OAuthConsent />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
