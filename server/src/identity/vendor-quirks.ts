/**
 * Deviations from what `openid-client` and RFC 6749 do by default, needed for specific
 * issuers rather than OIDC in general. `oidc.ts` stays a generic adapter -- no vendor named
 * in its code (issue #8) -- by keeping every such deviation here instead, opted into per
 * provider through `identity/registry.ts` configuration rather than assumed for everyone
 * `createOidcProvider` is pointed at. Issue #15 is why this file exists: the workaround
 * below used to live inline in `oidc.ts`.
 */
import * as oidc from "openid-client";

/**
 * HTTP Basic client auth with the credentials sent raw, not percent-encoded. Needed for
 * Supabase Cloud, and not known to be needed anywhere else -- both halves of the standard
 * behaviour are individually correct in general, so this is a per-issuer accommodation, not
 * a better default:
 *
 * 1. `discovery()` defaults to `ClientSecretPost` when handed a bare secret string, which
 *    is a perfectly ordinary client auth method -- Supabase simply doesn't register its
 *    OAuth clients for it, and rejects the mismatch outright ("client is registered for
 *    'client_secret_basic' but 'client_secret_post' was used").
 * 2. `oidc.ClientSecretBasic` form-url-encodes the credentials before Basic-encoding them,
 *    which is what RFC 6749 section 2.3.1 specifies. Supabase's token endpoint never
 *    decodes that layer back off -- and since the encoding percent-escapes `-`, a UUID
 *    client id arrives with every hyphen as `%2D` and is rejected as "Invalid client_id
 *    format". Verified against the live token endpoint: raw credentials authenticate,
 *    RFC-encoded ones 400. This is Supabase not implementing the spec's encoding step, not
 *    an ambiguity in the spec itself.
 *
 * The cost of the workaround is that a client id or secret containing `:` or non-ASCII
 * would be ambiguous here, where the RFC encoding would have escaped it. Supabase mints
 * both, as a UUID and a base64url-ish string, so neither can occur.
 *
 * Exported for `vendor-quirks.test.ts`, which pins the encoding -- swapping a provider back
 * to the library's own `ClientSecretBasic` without meaning to is the regression it exists
 * to catch.
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
