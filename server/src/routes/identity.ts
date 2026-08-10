/**
 * Generic identity-upgrade flow: one `start`/`callback` pair per configured provider
 * (`identity/registry.ts`), instead of a route module per provider. `github-oauth.ts` used
 * to hardcode this for GitHub; the provider-specific mechanics now live behind
 * `IdentityProvider` (`identity/provider.ts`) and this module only drives the shared
 * shape -- state/PKCE round-tripped through a cookie, then `upgradeViaIdentity`.
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { requirePrincipal, upgradeViaIdentity } from "../principal.js";
import type { IdentityProvider } from "../identity/provider.js";

/** OAuth failures land here after a browser navigation, not a JSON response the browser
 *  has nowhere to show -- `?auth_error=<code>` lets the site surface a message and clear
 *  it from the URL. */
function redirectWithError(siteUrl: string, code: string): string {
  const url = new URL(siteUrl);
  url.searchParams.set("auth_error", code);
  return url.toString();
}

const STATE_COOKIE = "sza_oauth_state";

interface StateCookiePayload {
  state: string;
  stash?: string;
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  pool: Pool,
  providers: ReadonlyMap<string, IdentityProvider>,
  { siteUrl, apiUrl }: { siteUrl: string; apiUrl: string },
): void {
  const auth = requirePrincipal(pool);

  app.get(
    "/api/auth/:provider/start",
    { preHandler: auth },
    async (request, reply) => {
      const { provider: providerName } = request.params as { provider: string };
      const provider = providers.get(providerName);
      if (!provider) {
        reply.redirect(redirectWithError(siteUrl, "oauth_not_configured"));
        return;
      }

      const redirectUri = `${apiUrl}/api/auth/${providerName}/callback`;
      const { url, state, stash } = await provider.start(redirectUri);
      const payload: StateCookiePayload = stash ? { state, stash } : { state };
      reply.setCookie(STATE_COOKIE, JSON.stringify(payload), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 600,
      });
      reply.redirect(url);
    },
  );

  app.get(
    "/api/auth/:provider/callback",
    { preHandler: auth },
    async (request, reply) => {
      const { provider: providerName } = request.params as { provider: string };
      const provider = providers.get(providerName);
      if (!provider) {
        reply.redirect(redirectWithError(siteUrl, "oauth_not_configured"));
        return;
      }

      const query = request.query as { code?: string; state?: string };
      const rawCookie = request.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: "/" });
      const saved: StateCookiePayload | undefined = rawCookie
        ? (JSON.parse(rawCookie) as StateCookiePayload)
        : undefined;

      if (
        !query.code ||
        !query.state ||
        !saved ||
        query.state !== saved.state
      ) {
        reply.redirect(redirectWithError(siteUrl, "invalid_oauth_state"));
        return;
      }

      const redirectUri = `${apiUrl}/api/auth/${providerName}/callback`;
      let identity;
      try {
        identity = await provider.finish({
          code: query.code,
          state: query.state,
          ...(saved.stash ? { stash: saved.stash } : {}),
          redirectUri,
        });
      } catch (error) {
        request.log.error(error);
        reply.redirect(
          redirectWithError(siteUrl, "oauth_token_exchange_failed"),
        );
        return;
      }

      await upgradeViaIdentity(
        pool,
        request,
        reply,
        request.principal.playerId,
        provider.name,
        identity.subject,
        identity.displayName,
      );
      reply.redirect(siteUrl);
    },
  );
}
