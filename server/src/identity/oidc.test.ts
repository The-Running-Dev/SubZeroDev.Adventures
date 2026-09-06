/**
 * Guards the availability property `oidc.ts`'s header describes: constructing an OIDC
 * provider must not touch the network, because `registry.ts` is awaited from `buildApp`
 * before the port is bound. When discovery ran eagerly there, an unreachable issuer -- a
 * DNS failure against the configured Supabase project, in the incident that prompted this
 * -- crash-looped the whole API, taking play, health, and the admin page down with sign-in.
 *
 * No `DATABASE_URL` needed; nothing here touches Postgres. The local server stands in for
 * the issuer so "unreachable" is a real socket outcome rather than a mocked one.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createOidcProvider } from "./oidc.js";

let server: Server | undefined;

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/**
 * A listening socket that is not a usable issuer, plus a count of how many times something
 * tried to reach it. Addressed as `https://` (the only scheme `openid-client` will talk to,
 * which is also why this cannot simply serve a 500 over plain HTTP): the client opens a TCP
 * connection, the TLS handshake fails against a plain HTTP listener, and discovery rejects
 * -- an attempt this counts at the `connection` event, below the protocol that fails.
 * Port 0, so the OS picks a free one and these tests never collide with a real service.
 */
async function brokenIssuer(): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  server = createServer((_request, response) => {
    response.writeHead(500).end("issuer is having a day");
  });
  server.on("connection", () => {
    hits += 1;
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null)
    throw new Error("expected a TCP address");
  return { url: `https://127.0.0.1:${address.port}`, hits: () => hits };
}

describe("createOidcProvider", () => {
  it("constructs without reaching the issuer, so an unreachable one cannot fail the boot", async () => {
    // Reserved by RFC 6761 to never resolve -- the closest thing to the production
    // ENOTFOUND without depending on any real name server.
    const provider = await createOidcProvider(
      "oidc",
      "https://issuer.invalid",
      "client-id",
      "client-secret",
    );
    expect(provider.name).toBe("oidc");
  });

  it("still rejects a malformed issuer URL eagerly -- that is a config error, not an outage", async () => {
    await expect(
      createOidcProvider("oidc", "not-a-url", "client-id", "client-secret"),
    ).rejects.toThrow();
  });

  it("surfaces the discovery failure on the sign-in attempt instead", async () => {
    const { url } = await brokenIssuer();
    const provider = await createOidcProvider(
      "oidc",
      url,
      "client-id",
      "client-secret",
    );
    await expect(provider.start(`${url}/callback`)).rejects.toThrow(
      /OIDC discovery/,
    );
  });

  it("does not memoize a failure, so an issuer that comes back works without a restart", async () => {
    const { url, hits } = await brokenIssuer();
    const provider = await createOidcProvider(
      "oidc",
      url,
      "client-id",
      "client-secret",
    );

    await expect(provider.start(`${url}/callback`)).rejects.toThrow();
    await expect(provider.start(`${url}/callback`)).rejects.toThrow();

    // Two attempts, not one: a cached rejection would have disabled sign-in until someone
    // redeployed, which is the failure mode this whole change exists to remove.
    expect(hits()).toBeGreaterThanOrEqual(2);
  });
});
