/**
 * Any real OIDC issuer as an `IdentityProvider` -- discovery, authorization-code +
 * PKCE, JWKS-validated `id_token`. Fully generic: the issuer, client id, and secret are
 * the only inputs, so pointing this at a different provider (Supabase Cloud today, or a
 * mock issuer in a test) is a configuration change, not a code change. No provider SDK --
 * `openid-client` speaks the protocol, not a vendor's dialect of it.
 */
import * as oidc from "openid-client";
import type { IdentityProvider } from "./provider.js";

export async function createOidcProvider(
  name: string,
  issuerUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<IdentityProvider> {
  const config = await oidc.discovery(
    new URL(issuerUrl),
    clientId,
    clientSecret,
  );

  return {
    name,

    async start(redirectUri) {
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const state = oidc.randomState();
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: "openid profile email",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      });
      return { url: url.toString(), state, stash: codeVerifier };
    },

    async finish({ code, state, stash, redirectUri }) {
      if (!stash) throw new Error(`${name}: missing PKCE verifier`);
      const currentUrl = new URL(redirectUri);
      currentUrl.searchParams.set("code", code);
      currentUrl.searchParams.set("state", state);
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: stash,
        expectedState: state,
      });
      const claims = tokens.claims();
      const sub = claims?.sub;
      if (!sub) throw new Error(`${name}: id token carried no sub claim`);
      const displayName = claims?.name ?? claims?.email;
      return {
        subject: sub,
        ...(typeof displayName === "string" ? { displayName } : {}),
      };
    },
  };
}
