import { useOnline } from "../pwa/usePwa";
import { ResourceState } from "../components/ResourceState";
import { useTranslation } from "react-i18next";
/**
 * The authorization UI Supabase's OAuth 2.1 Server redirects to (Site URL + Authorization
 * Path, configured in that Supabase project's dashboard as `/oauth/consent`) -- see
 * supabaseClient.ts's header for how this differs from `../play/identity.ts`. Rendered
 * by the application router at `/oauth/consent`.
 *
 * Two logins happen across this flow and they are not the same thing: signing in here
 * (email magic link, against Supabase's own auth) only proves who's granting consent. The
 * OAuth token that consent produces is what `server/src/identity/oidc.ts` later exchanges
 * to link *this* app's guest player to a Supabase-authenticated identity -- this page never
 * touches that part.
 */
import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import type { OAuthAuthorizationClient } from "@supabase/supabase-js";

type Stage =
  | { readonly kind: "loading" }
  | { readonly kind: "not_configured" }
  | { readonly kind: "missing_authorization_id" }
  | { readonly kind: "sign_in"; readonly authorizationId: string }
  | { readonly kind: "sign_in_sent"; readonly email: string }
  | {
      readonly kind: "consent";
      readonly authorizationId: string;
      readonly client: OAuthAuthorizationClient;
      readonly scope: string;
    }
  | { readonly kind: "redirecting" }
  | { readonly kind: "error"; readonly message: string };

export function OAuthConsent() {
  const { t } = useTranslation("account");
  const online = useOnline();
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setStage({ kind: "not_configured" });
      return;
    }
    const authorizationId = new URLSearchParams(window.location.search).get(
      "authorization_id",
    );
    if (!authorizationId) {
      setStage({ kind: "missing_authorization_id" });
      return;
    }

    let cancelled = false;
    async function load(client: NonNullable<typeof supabase>, id: string) {
      const {
        data: { user },
      } = await client.auth.getUser();
      if (cancelled) return;
      if (!user) {
        setStage({ kind: "sign_in", authorizationId: id });
        return;
      }

      const { data, error } =
        await client.auth.oauth.getAuthorizationDetails(id);
      if (cancelled) return;
      if (error) {
        setStage({ kind: "error", message: error.message });
        return;
      }
      if ("authorization_id" in data) {
        setStage({
          kind: "consent",
          authorizationId: id,
          client: data.client,
          scope: data.scope,
        });
      } else {
        // Already consented to these scopes -- Supabase issued the code without asking
        // again. Same redirect the approve button below triggers.
        setStage({ kind: "redirecting" });
        window.location.href = data.redirect_url;
      }
    }
    void load(supabase, authorizationId).catch(() => {
      if (!cancelled) setStage({ kind: "error", message: "network_error" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function sendMagicLink(): Promise<void> {
    if (!supabase || !email.trim()) return;
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // Sends the visitor right back to this same authorization_id URL after they click
      // the emailed link, so the useEffect above picks up mid-flow with a session now set.
      options: { emailRedirectTo: window.location.href },
    });
    setBusy(false);
    if (error) {
      setStage({ kind: "error", message: error.message });
      return;
    }
    setStage({ kind: "sign_in_sent", email: email.trim() });
  }

  async function decide(
    authorizationId: string,
    decision: "approve" | "deny",
  ): Promise<void> {
    if (!supabase) return;
    setBusy(true);
    const { data, error } =
      decision === "approve"
        ? await supabase.auth.oauth.approveAuthorization(authorizationId)
        : await supabase.auth.oauth.denyAuthorization(authorizationId);
    setBusy(false);
    if (error) {
      setStage({ kind: "error", message: error.message });
      return;
    }
    setStage({ kind: "redirecting" });
    window.location.href = data.redirect_url;
  }

  return (
    <>
      <section
        className="feature-page archive"
        aria-labelledby="oauth-consent-title"
      >
        {!online && <ResourceState state="offline" />}
        <div className="archive-heading">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1 id="oauth-consent-title">{t("consentTitle")}</h1>
          {stage.kind === "loading" && <p>{t("checking")}</p>}
          {stage.kind === "not_configured" && <p>{t("notConfigured")}</p>}
          {stage.kind === "missing_authorization_id" && (
            <p>{t("missingRequest")}</p>
          )}
          {stage.kind === "error" && (
            <p className="account-error" role="alert">
              {t("oauth_token_exchange_failed")}
            </p>
          )}
          {stage.kind === "redirecting" && <p>{t("redirecting")}</p>}
          {stage.kind === "sign_in" && (
            <div className="account-panel">
              <p>{t("emailIntro")}</p>
              <div className="account-chip">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  aria-label={t("email")}
                />
                <button
                  className="cabinet-button primary"
                  disabled={!online || busy || !email.trim()}
                  onClick={() =>
                    void sendMagicLink().catch(() => {
                      setBusy(false);
                      setStage({ kind: "error", message: "network_error" });
                    })
                  }
                >
                  {t("sendLink")}
                </button>
              </div>
            </div>
          )}
          {stage.kind === "sign_in_sent" && (
            <p>{t("sent", { email: stage.email })}</p>
          )}
          {stage.kind === "consent" && (
            <div className="account-panel">
              <p>{t("clientRequest", { client: stage.client.name })}</p>
              {stage.scope.trim() && (
                <p>{t("scope", { scope: stage.scope })}</p>
              )}
              <div className="account-chip">
                <button
                  className="cabinet-button primary"
                  disabled={!online || busy}
                  onClick={() =>
                    void decide(stage.authorizationId, "approve").catch(() => {
                      setBusy(false);
                      setStage({ kind: "error", message: "network_error" });
                    })
                  }
                >
                  {t("approve")}
                </button>
                <button
                  className="cabinet-button quiet"
                  disabled={!online || busy}
                  onClick={() =>
                    void decide(stage.authorizationId, "deny").catch(() => {
                      setBusy(false);
                      setStage({ kind: "error", message: "network_error" });
                    })
                  }
                >
                  {t("deny")}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
