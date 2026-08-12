import { afterEach, describe, expect, it } from "vitest";
import { createDevIdentityProvider } from "./dev.js";
import { loadIdentityProviders } from "./registry.js";

describe("dev identity provider", () => {
  it("resolves to a fixed subject via a redirect that carries no external round-trip", async () => {
    const provider = createDevIdentityProvider();
    const { url, state } = await provider.start(
      "http://localhost:8787/api/auth/dev/callback",
    );

    // The whole point of a dev provider: `start` hands back the callback URL itself,
    // already carrying the code and state a real issuer would only produce after a
    // consent screen -- routes/identity.ts's `reply.redirect(url)` lands the browser
    // straight on its own callback.
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:8787/api/auth/dev/callback",
    );
    expect(parsed.searchParams.get("state")).toBe(state);

    const identity = await provider.finish({
      code: parsed.searchParams.get("code")!,
      state,
      redirectUri: "http://localhost:8787/api/auth/dev/callback",
    });
    expect(identity.subject).toBe("local-dev");
  });

  it("refuses a code it did not issue", async () => {
    const provider = createDevIdentityProvider();
    await expect(
      provider.finish({
        code: "not-the-dev-code",
        state: "whatever",
        redirectUri: "http://localhost:8787/api/auth/dev/callback",
      }),
    ).rejects.toThrow();
  });

  it("mints a different state per start() call", async () => {
    const provider = createDevIdentityProvider();
    const first = await provider.start("http://localhost:8787/cb");
    const second = await provider.start("http://localhost:8787/cb");
    expect(first.state).not.toBe(second.state);
  });
});

describe("loadIdentityProviders + DEV_IDENTITY", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers only the dev provider when DEV_IDENTITY=1, ignoring any configured OIDC", async () => {
    process.env.DEV_IDENTITY = "1";
    process.env.NODE_ENV = "development";
    // Present to prove DEV_IDENTITY wins outright rather than merely filling a gap --
    // mirrors "one configured provider today" (session.ts's `signInProvider`), so the two
    // must never coexist.
    process.env.OIDC_ISSUER_URL = "https://issuer.example.com";
    process.env.OIDC_CLIENT_ID = "client";
    process.env.OIDC_CLIENT_SECRET = "secret";

    const providers = await loadIdentityProviders();
    expect([...providers.keys()]).toEqual(["dev"]);
  });

  it("refuses to start when DEV_IDENTITY=1 and NODE_ENV=production", async () => {
    process.env.DEV_IDENTITY = "1";
    process.env.NODE_ENV = "production";

    await expect(loadIdentityProviders()).rejects.toThrow(/production/);
  });

  it("registers no provider at all when DEV_IDENTITY is unset and no OIDC is configured", async () => {
    delete process.env.DEV_IDENTITY;
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;

    const providers = await loadIdentityProviders();
    expect(providers.size).toBe(0);
  });
});
