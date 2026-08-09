/**
 * Assembles the configured `IdentityProvider`s from the environment at startup. Unset
 * credentials for a provider simply omit it from the map -- routes/identity.ts answers
 * `oauth_not_configured` for a provider that isn't present, the same graceful-absence
 * posture the old GitHub-only routes had.
 *
 * `OIDC_PROVIDER_NAME` names the one generic OIDC provider this deployment configures --
 * "supabase" today, pointed at the deployment's Supabase Cloud project via
 * `OIDC_ISSUER_URL`. Swapping providers, or adding a second, is an environment-variable
 * change; nothing here names Supabase specifically.
 */
import { createGithubProvider } from "./github.js";
import { createOidcProvider } from "./oidc.js";
import type { IdentityProvider } from "./provider.js";

export async function loadIdentityProviders(): Promise<
  ReadonlyMap<string, IdentityProvider>
> {
  const providers = new Map<string, IdentityProvider>();

  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (githubClientId && githubClientSecret) {
    providers.set(
      "github",
      createGithubProvider(githubClientId, githubClientSecret),
    );
  }

  const oidcIssuer = process.env.OIDC_ISSUER_URL;
  const oidcClientId = process.env.OIDC_CLIENT_ID;
  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;
  if (oidcIssuer && oidcClientId && oidcClientSecret) {
    // `||`, not `??` -- docker-compose.yml's `${OIDC_PROVIDER_NAME:-}` interpolation makes
    // an unset value an empty string inside the container, not literally absent.
    const name = process.env.OIDC_PROVIDER_NAME || "oidc";
    providers.set(
      name,
      await createOidcProvider(
        name,
        oidcIssuer,
        oidcClientId,
        oidcClientSecret,
      ),
    );
  }

  return providers;
}
