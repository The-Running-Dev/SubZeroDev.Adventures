/**
 * Assembles the configured `IdentityProvider`s from the environment at startup. Unset
 * credentials for a provider simply omit it from the map -- routes/identity.ts answers
 * `oauth_not_configured` for a provider that isn't present.
 *
 * `OIDC_PROVIDER_NAME` names the one generic OIDC provider this deployment configures --
 * "supabase" today, pointed at the deployment's Supabase Cloud project via
 * `OIDC_ISSUER_URL`. Swapping providers, or adding a second, is an environment-variable
 * change; nothing here names Supabase specifically.
 *
 * `OIDC_RAW_BASIC_AUTH` opts into `identity/vendor-quirks.ts`'s non-spec client
 * authentication, which Supabase Cloud needs and no other issuer is known to. This is the
 * one place a vendor's name may appear outside `identity/` itself (issue #8), and it does
 * so only in this comment, not in code -- the variable is generic across any issuer with
 * the same quirk.
 */
import { createOidcProvider } from "./oidc.js";
import { clientSecretBasicRaw } from "./vendor-quirks.js";
import type { IdentityProvider } from "./provider.js";

export async function loadIdentityProviders(): Promise<
  ReadonlyMap<string, IdentityProvider>
> {
  const providers = new Map<string, IdentityProvider>();

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
        process.env.OIDC_RAW_BASIC_AUTH
          ? clientSecretBasicRaw(oidcClientSecret)
          : undefined,
      ),
    );
  }

  return providers;
}
