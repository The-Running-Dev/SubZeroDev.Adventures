import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Link, matchPath, useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { ErrorBoundary } from "../../app/ErrorBoundary";
import { ResourceState } from "../../components/ResourceState";

const PlayApp = lazy(() => import("../../play/PlayApp"));

/** One mounted player per identity generation, outside the route outlet. Hiding a
 * route preserves its live engine client; changing campaigns creates a fresh client.
 * Durable refresh/resume still uses the existing save protocol. */
export function PlayerHost() {
  const { pathname } = useLocation();
  const requested = matchPath("/play/:campaignId", pathname)?.params.campaignId;
  const [retained, setRetained] = useState<string | undefined>(requested);
  const campaignId = requested ?? retained;
  const navigate = useNavigate();
  const { t } = useTranslation("play");
  useEffect(() => {
    if (requested) setRetained(requested);
  }, [requested]);
  const close = useCallback(() => {
    setRetained(undefined);
    navigate("/");
  }, [navigate]);
  const leave = useCallback(() => navigate("/"), [navigate]);
  if (!campaignId) return null;
  return (
    <>
      {!requested && (
        <Link
          className="app-button return-to-game"
          to={`/play/${encodeURIComponent(campaignId)}`}
        >
          {t("returnToGame")}
        </Link>
      )}
      <div hidden={!requested} inert={!requested}>
        <ErrorBoundary
          key={campaignId}
          fallback={(retry) => (
            <section className="app-panel" role="alert">
              <h1>{t("renderError")}</h1>
              <button className="app-button" onClick={retry}>
                {t("retry")}
              </button>
              <Link to="/">{t("library")}</Link>
            </section>
          )}
        >
          <Suspense fallback={<ResourceState state="loading" />}>
            <PlayApp
              key={campaignId}
              initialCampaignId={campaignId}
              active={Boolean(requested)}
              onClose={close}
              onNavigateLibrary={leave}
            />
          </Suspense>
        </ErrorBoundary>
      </div>
    </>
  );
}
