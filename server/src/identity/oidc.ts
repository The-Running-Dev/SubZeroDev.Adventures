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

/**
 * HTTP Basic client auth, spelled out here rather than using `oidc.ClientSecretBasic`,
 * because both halves are load-bearing against Supabase:
 *
 * 1. It must be Basic at all. `discovery()` defaults to `ClientSecretPost` when handed a
 *    bare secret string, and Supabase registers its OAuth clients for
 *    `client_secret_basic`, rejecting the mismatch outright ("client is registered for
 *    'client_secret_basic' but 'client_secret_post' was used").
 * 2. The credentials must go in *raw*. `oidc.ClientSecretBasic` form-url-encodes them
 *    first, which RFC 6749 section 2.3.1 does call for, but Supabase never decodes them
 *    again -- and since that encoding percent-escapes `-`, a UUID client id arrives with
 *    every hyphen as `%2D` and is rejected as "Invalid client_id format". Verified against
 *    the live token endpoint: raw credentials authenticate, encoded ones 400.
 *
 * The cost of the workaround is that a client id or secret containing `:` or non-ASCII
 * would be ambiguous here, where the RFC encoding would have escaped it. Supabase mints
 * both, as a UUID and a base64url-ish string, so neither can occur.
 *
 * Exported for `oidc.test.ts`, which pins the encoding -- swapping this back to the
 * library's own `ClientSecretBasic` is the regression it exists to catch.
 */
export function clientSecretBasicRaw(clientSecret: string): oidc.ClientAuth {
  return (_as, client, _body, headers) => {
    const credentials = Buffer.from(
      `${client.client_id}:${clientSecret}`,
      "utf8",
    ).toString("base64");
    headers.set("authorization", `Basic ${credentials}`);
  };
}

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
    clientSecretBasicRaw(clientSecret),
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
