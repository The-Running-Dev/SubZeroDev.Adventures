/**
 * A fake `IdentityProvider` for the localhost preview loop (docs/preview.md) -- no issuer,
 * no network, no browser consent screen. `start()` redirects straight back to the callback
 * with a canned code; `finish()` returns a fixed subject. That still exercises the real
 * path end to end (state cookie, callback, `upgradeViaIdentity`, session rotation,
 * sign-out) with a "Sign in" button that just works, which is the whole point: it replaces
 * hand-promoting a guest in SQL, not just the UI around it, because it goes through the
 * exact same `upgradeViaIdentity` call a real provider's callback does.
 *
 * A fixed subject rather than a fresh one per call is deliberate: repeated dev sign-ins
 * resolve to the same player every time, mirroring what "sign in as yourself" actually
 * means for a real provider, and letting a `PLAYER_ID`-style env override be added later
 * without another design.
 *
 * `registry.ts` is the only caller, and only when `DEV_IDENTITY=1` -- and it refuses that
 * outright in production (`NODE_ENV === "production"`), so this can never end up live on
 * the deployed API by nothing more than a stray environment variable.
 */
import type { IdentityProvider } from "./provider.js";

const DEV_SUBJECT = "local-dev";
const DEV_CODE = "dev";

export function createDevIdentityProvider(): IdentityProvider {
  return {
    name: "dev",
    async start(redirectUri) {
      // No issuer round-trip to carry a value through, so `state` only has to satisfy
      // `routes/identity.ts`'s own check that the callback's `state` matches what `start`
      // handed back via the short-lived cookie -- any unique-enough string does.
      const state = crypto.randomUUID();
      const url = new URL(redirectUri);
      url.searchParams.set("code", DEV_CODE);
      url.searchParams.set("state", state);
      return { url: url.toString(), state };
    },
    async finish({ code }) {
      if (code !== DEV_CODE) {
        // Guards against a stale `sza_oauth_state` cookie replaying an old code across a
        // server restart, not a real adversary -- this whole provider is dev-only.
        throw new Error("dev identity: unexpected code");
      }
      return { subject: DEV_SUBJECT, displayName: "Local Dev" };
    },
  };
}
