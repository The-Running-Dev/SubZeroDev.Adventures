/**
 * The authorization UI Supabase's OAuth 2.1 Server redirects to (Site URL + Authorization
 * Path, configured in that Supabase project's dashboard as `/oauth/consent`) -- see
 * supabaseClient.ts's header for how this differs from `../play/identity.ts`. Rendered
 * directly by main.tsx when `location.pathname === "/oauth/consent"`; there is no router in
 * this app, so this is the one other path it knows about besides `/`.
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
    void load(supabase, authorizationId);
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
    <main className="play-main">
      <section className="archive" aria-labelledby="oauth-consent-title">
        <div className="archive-heading">
          <p className="eyebrow">SUBZERO STORY SYSTEM // ACCOUNT LINK</p>
          <h1 id="oauth-consent-title">Sign-in request</h1>
          {stage.kind === "loading" && <p>Checking your session…</p>}
          {stage.kind === "not_configured" && (
            <p>
              This deployment hasn't configured a Supabase identity provider
              yet. There is nothing to authorize here.
            </p>
          )}
          {stage.kind === "missing_authorization_id" && (
            <p>
              This page only makes sense as a redirect target from a third-party
              sign-in request -- there's no request to show.
            </p>
          )}
          {stage.kind === "error" && (
            <p className="account-error" role="alert">
              {stage.message}
            </p>
          )}
          {stage.kind === "redirecting" && <p>Redirecting…</p>}
          {stage.kind === "sign_in" && (
            <div className="account-panel">
              <p>
                Enter your email and we'll send a one-time sign-in link to
                confirm it's you before you approve anything.
              </p>
              <div className="account-chip">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  aria-label="Email address"
                />
                <button
                  className="cabinet-button primary"
                  disabled={busy || !email.trim()}
                  onClick={() => void sendMagicLink()}
                >
                  Send sign-in link
                </button>
              </div>
            </div>
          )}
          {stage.kind === "sign_in_sent" && (
            <p>
              Sign-in link sent to <strong>{stage.email}</strong>. Open it on
              this device to continue -- this tab will pick up where it left
              off.
            </p>
          )}
          {stage.kind === "consent" && (
            <div className="account-panel">
              <p>
                <strong>{stage.client.name}</strong> wants to sign you in using
                this account.
              </p>
              {stage.scope.trim() && <p>Requested access: {stage.scope}</p>}
              <div className="account-chip">
                <button
                  className="cabinet-button primary"
                  disabled={busy}
                  onClick={() => void decide(stage.authorizationId, "approve")}
                >
                  Approve
                </button>
                <button
                  className="cabinet-button quiet"
                  disabled={busy}
                  onClick={() => void decide(stage.authorizationId, "deny")}
                >
                  Deny
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
