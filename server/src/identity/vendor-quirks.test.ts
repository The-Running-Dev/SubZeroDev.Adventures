/**
 * Pins how client credentials reach the token endpoint. This is the one part of the OIDC
 * flow with no coverage from `api.test.ts` (which never reaches an identity provider), and
 * the part that silently broke every real sign-in: the credentials were going out
 * form-url-encoded, so a UUID client id arrived with every hyphen as `%2D` and Supabase
 * answered "Invalid client_id format" for weeks of green test runs.
 *
 * These assert the wire format directly rather than standing up a mock issuer.
 * `openid-client` refuses a non-HTTPS issuer unless the `Configuration` opts out, so an
 * `http://localhost` mock would mean loosening that in production code to satisfy a test.
 * The wire format is also the whole of what regressed -- a mock issuer would only catch it
 * by asserting these same bytes, one HTTP hop further away.
 */
import { describe, expect, it } from "vitest";
import * as oidc from "openid-client";
import { clientSecretBasicRaw } from "./vendor-quirks.js";

// Hyphens are the entire point: they are what `ClientSecretBasic`'s RFC 6749 section 2.3.1
// encoding escapes, and Supabase issues client ids as UUIDs. A hyphen-free fixture would
// make both implementations agree and the regression invisible.
const CLIENT_ID = "41c3ef36-6349-44c1-9975-f8c2cc32ed48";
const CLIENT_SECRET = "test-secret-with-hyphens_and.dots";

/** Runs a `ClientAuth` the way `openid-client` does and hands back what it wrote. */
function applyAuth(auth: oidc.ClientAuth): {
  headers: Headers;
  body: URLSearchParams;
} {
  const headers = new Headers();
  const body = new URLSearchParams();
  auth(
    {} as oidc.ServerMetadata,
    { client_id: CLIENT_ID } as oidc.ClientMetadata,
    body,
    headers,
  );
  return { headers, body };
}

function decodeBasic(headers: Headers): string {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Basic "))
    throw new Error(
      `expected a Basic authorization header, got ${authorization}`,
    );
  return Buffer.from(authorization.slice("Basic ".length), "base64").toString(
    "utf8",
  );
}

describe("clientSecretBasicRaw", () => {
  it("sends the credentials in an Authorization header, not the body", () => {
    const { headers, body } = applyAuth(clientSecretBasicRaw(CLIENT_SECRET));

    expect(headers.get("authorization")).toMatch(/^Basic /);
    // `client_secret_post` puts both of these in the body instead, which is the auth
    // method Supabase rejects outright for a client registered as basic.
    expect(body.get("client_id")).toBeNull();
    expect(body.get("client_secret")).toBeNull();
  });

  it("base64s the credentials verbatim, leaving hyphens unescaped", () => {
    const { headers } = applyAuth(clientSecretBasicRaw(CLIENT_SECRET));

    expect(decodeBasic(headers)).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);
    expect(decodeBasic(headers)).not.toContain("%2D");
  });

  it("differs from the library's ClientSecretBasic, which percent-escapes hyphens", () => {
    // Not a preference between the two -- this is the exact substitution that broke
    // sign-in, so it is worth failing loudly rather than leaving the custom
    // implementation looking like an arbitrary reimplementation someone may tidy away.
    const ours = decodeBasic(
      applyAuth(clientSecretBasicRaw(CLIENT_SECRET)).headers,
    );
    const library = decodeBasic(
      applyAuth(oidc.ClientSecretBasic(CLIENT_SECRET)).headers,
    );

    expect(library).toContain("%2D");
    expect(ours).not.toBe(library);
  });
});
