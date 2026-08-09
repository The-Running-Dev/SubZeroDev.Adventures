/**
 * The one interface every sign-in provider implements. Nothing outside this directory
 * knows whether a given provider speaks OIDC or something else -- `principal.ts` and the
 * routes that drive the sign-in flow only ever see `IdentityProvider`.
 *
 * GitHub does not speak OIDC (no discovery document, no `id_token`) -- "sign in with
 * GitHub" is plain OAuth2 against its own REST API. `github.ts` implements this same
 * interface with GitHub's native mechanics rather than forcing it through OIDC discovery
 * machinery it doesn't support. `oidc.ts` implements it for any real OIDC issuer (the
 * deployment's configured Supabase project, or any mock issuer in a test) via
 * `openid-client`. Provider-specific code lives behind exactly this interface and nowhere
 * else -- a second provider is a second file, not a second design.
 */
export interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  /** Provider-specific data the callback needs back (a PKCE verifier, for OIDC) --
   *  opaque to everything except the adapter that produced it. `principal.ts` round-trips
   *  it through a short-lived cookie without ever reading it. */
  readonly stash?: string;
}

export interface ResolvedIdentity {
  readonly subject: string;
  readonly displayName?: string;
}

export interface IdentityProvider {
  readonly name: string;
  start(redirectUri: string): Promise<AuthorizationRequest>;
  finish(params: {
    code: string;
    state: string;
    stash?: string;
    redirectUri: string;
  }): Promise<ResolvedIdentity>;
}
