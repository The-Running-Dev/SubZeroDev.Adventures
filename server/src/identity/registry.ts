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
 * `identity/vendor-quirks.ts`'s non-spec client authentication is the *default* here,
 * deliberately -- Supabase Cloud is the only issuer this deployment has ever pointed at,
 * and defaulting the other way once already broke production sign-in silently (issue #15
 * flipped the default to spec-compliant behind a new opt-in var, and the deployment's
 * environment was never updated to set it -- the exact encoding regression `a2faa88` and
 * `69317ee` had already fixed and pinned, back from the dead). `OIDC_SPEC_COMPLIANT_BASIC_AUTH`
 * opts *out* of the quirk for a future issuer configured through this same adapter that
 * doesn't need it, rather than requiring every deployment to opt in to keep working. This
 * is the one place a vendor's name may appear outside `identity/` itself (issue #8), and
 * it does so only in this comment, not in code.
 */
import { createOidcProvider } from "./oidc.js";
import { createDevIdentityProvider } from "./dev.js";
import { clientSecretBasicRaw } from "./vendor-quirks.js";
import type { IdentityProvider } from "./provider.js";

export async function loadIdentityProviders(): Promise<
  ReadonlyMap<string, IdentityProvider>
> {
  const providers = new Map<string, IdentityProvider>();

  // `dev.ts`'s fake provider -- localhost sign-in with no issuer to configure (docs/
  // preview.md). Refused outright in production regardless of `DEV_IDENTITY`, so this can
  // never reach the deployed API by nothing more than a stray environment variable: the
  // deployed docker-compose.yml would have to both set `NODE_ENV=production` (it already
  // does) *and* stop setting it, which is not something one variable slipping in can do.
  if (process.env.DEV_IDENTITY === "1") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DEV_IDENTITY=1 is refused when NODE_ENV=production -- this provider is a fake sign-in and must never run on the deployed API.",
      );
    }
    providers.set("dev", createDevIdentityProvider());
    return providers;
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
        process.env.OIDC_SPEC_COMPLIANT_BASIC_AUTH
          ? undefined
          : clientSecretBasicRaw(oidcClientSecret),
      ),
    );
  }

  return providers;
}
