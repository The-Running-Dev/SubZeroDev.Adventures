/**
 * GitHub as an `IdentityProvider` -- its own OAuth2 mechanics (GitHub has no OIDC
 * discovery or `id_token`), behind the same interface every other provider implements.
 * This is the pre-existing flow from the old `routes/github-oauth.ts`, unchanged in
 * substance, just conforming to `IdentityProvider` instead of being its own route module.
 */
import { randomBytes } from "node:crypto";
import type { IdentityProvider } from "./provider.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

interface GithubTokenResponse {
  access_token?: string;
  error?: string;
}

interface GithubUserResponse {
  id: number;
  login: string;
  name: string | null;
}

export function createGithubProvider(
  clientId: string,
  clientSecret: string,
): IdentityProvider {
  return {
    name: "github",

    async start(redirectUri) {
      const state = randomBytes(16).toString("hex");
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "read:user");
      url.searchParams.set("state", state);
      return { url: url.toString(), state };
    },

    async finish({ code, redirectUri }) {
      const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenBody = (await tokenResponse.json()) as GithubTokenResponse;
      if (!tokenBody.access_token) {
        throw new Error("github: token exchange failed");
      }

      const userResponse = await fetch(GITHUB_USER_URL, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: "application/json",
          "user-agent": "subzerodev-adventures",
        },
      });
      const user = (await userResponse.json()) as GithubUserResponse;
      return { subject: String(user.id), displayName: user.name ?? user.login };
    },
  };
}
