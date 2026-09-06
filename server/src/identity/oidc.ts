/**
 * Any real OIDC issuer as an `IdentityProvider` -- discovery, authorization-code +
 * PKCE, JWKS-validated `id_token`. Fully generic: the issuer, client id, and secret are
 * the only inputs, so pointing this at a different provider (Supabase Cloud today, or a
 * mock issuer in a test) is a configuration change, not a code change. No provider SDK --
 * `openid-client` speaks the protocol, not a vendor's dialect of it.
 *
 * **Discovery is lazy, and that is a availability property, not an optimization.** It used
 * to run inside `createOidcProvider`, which `registry.ts` awaits from `buildApp` before the
 * port is bound -- so an issuer that would not resolve took the whole API down at boot, and
 * kept it down under `restart: unless-stopped`. A DNS failure reaching the issuer did
 * exactly that in production. Sign-in depends on the issuer; playing, health, the admin
 * page and the content routes do not, and none of them should die because a third party is
 * unreachable. So the network call moved to the first `start`/`finish` that actually needs
 * it, where a failure is one refused sign-in (`routes/identity.ts` redirects with
 * `oauth_provider_unavailable`) instead of a dead deployment.
 *
 * Only a *successful* discovery is memoized. A failed one is not cached, so an issuer that
 * comes back -- DNS recovering, the project waking up -- starts working again on the next
 * attempt, with no restart. That is the other half of the same property: a transient
 * failure must not disable sign-in until someone notices and redeploys.
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
  // Parsed eagerly: a malformed `OIDC_ISSUER_URL` is a configuration error the operator can
  // fix without the issuer being reachable, so it should still be loud at startup. Only the
  // *network* part is deferred.
  const issuer = new URL(issuerUrl);
  let discovered: Promise<oidc.Configuration> | undefined;

  function configure(): Promise<oidc.Configuration> {
    if (!discovered) {
      discovered = oidc
        .discovery(issuer, clientId, clientSecret, clientAuth)
        // Drop the rejected promise so the next call retries rather than replaying the
        // failure forever -- see the header on why a transient outage must not stick.
        .catch((error: unknown) => {
          discovered = undefined;
          throw new Error(
            `${name}: OIDC discovery against ${issuer.origin} failed`,
            { cause: error },
          );
        });
    }
    return discovered;
  }

  return {
    name,

    async start(redirectUri) {
      const config = await configure();
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
      const config = await configure();
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
