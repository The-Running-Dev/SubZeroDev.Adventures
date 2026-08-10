/**
 * Any real OIDC issuer as an `IdentityProvider` -- discovery, authorization-code +
 * PKCE, JWKS-validated `id_token`. Fully generic: the issuer, client id, and secret are
 * the only inputs, so pointing this at a different provider (Supabase Cloud today, or a
 * mock issuer in a test) is a configuration change, not a code change. No provider SDK --
 * `openid-client` speaks the protocol, not a vendor's dialect of it.
 */
import * as oidc from "openid-client";
import type { IdentityProvider } from "./provider.js";

/**
 * `openid-client` reports any non-conforming token response as the same opaque
 * "unexpected HTTP response status code", stranding the issuer's own explanation on the
 * unread `cause` Response. Every OAuth misconfiguration this code can hit -- wrong client
 * auth method, stale secret, redirect-uri mismatch -- surfaces there and nowhere else, so
 * it gets folded into the thrown error rather than left for whoever is holding a debugger.
 * Only error responses are read; a success never reaches this path.
 */
async function withProviderDetail<T>(
  name: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (!(cause instanceof Response)) throw error;
    const detail = await cause
      .clone()
      .text()
      .catch(() => "<unreadable body>");
    throw new Error(
      `${name}: token endpoint returned ${cause.status} ${cause.statusText} -- ${detail}`,
      { cause: error },
    );
  }
}

export async function createOidcProvider(
  name: string,
  issuerUrl: string,
  clientId: string,
  clientSecret: string,
  // Spec-compliant Basic auth by default. A specific issuer's deviation from that (e.g.
  // Supabase's; see `identity/vendor-quirks.ts`) is opted into by the caller, per provider,
  // rather than assumed for every issuer this function is pointed at -- issue #15.
  clientAuth: oidc.ClientAuth = oidc.ClientSecretBasic(clientSecret),
): Promise<IdentityProvider> {
  const config = await oidc.discovery(
    new URL(issuerUrl),
    clientId,
    clientSecret,
    clientAuth,
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
      const tokens = await withProviderDetail(name, () =>
        oidc.authorizationCodeGrant(config, currentUrl, {
          pkceCodeVerifier: stash,
          expectedState: state,
        }),
      );
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
