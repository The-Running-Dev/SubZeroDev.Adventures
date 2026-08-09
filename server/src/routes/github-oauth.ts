/**
 * GitHub OAuth upgrade flow. `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are read from the
 * environment only -- provisioning the OAuth app and setting those values (locally in
 * `server/.env`, and on the VPS) is the operator's job, not this code's.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { requirePlayer, upgradeToGithub } from "../auth.js";

/** OAuth failures land here after a browser navigation, not a JSON response the browser
 *  has nowhere to show -- `?auth_error=<code>` lets the site surface a message and clear
 *  it from the URL. */
function redirectWithError(siteUrl: string, code: string): string {
  const url = new URL(siteUrl);
  url.searchParams.set("auth_error", code);
  return url.toString();
}

const STATE_COOKIE = "sza_oauth_state";
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

export function registerGithubOAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
): void {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const siteUrl = process.env.SITE_URL ?? "http://localhost:5173";
  const apiUrl = process.env.API_URL ?? "http://localhost:8787";

  app.get(
    "/api/auth/github/start",
    { preHandler: requirePlayer(pool) },
    async (_request, reply) => {
      if (!clientId) {
        reply.redirect(redirectWithError(siteUrl, "oauth_not_configured"));
        return;
      }
      const state = randomBytes(16).toString("hex");
      reply.setCookie(STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 600,
      });
      const redirectUri = `${apiUrl}/api/auth/github/callback`;
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "read:user");
      url.searchParams.set("state", state);
      reply.redirect(url.toString());
    },
  );

  app.get(
    "/api/auth/github/callback",
    { preHandler: requirePlayer(pool) },
    async (request, reply) => {
      if (!clientId || !clientSecret) {
        reply.redirect(redirectWithError(siteUrl, "oauth_not_configured"));
        return;
      }
      const query = request.query as { code?: string; state?: string };
      const expectedState = request.cookies[STATE_COOKIE];
      reply.clearCookie(STATE_COOKIE, { path: "/" });

      if (!query.code || !query.state || query.state !== expectedState) {
        reply.redirect(redirectWithError(siteUrl, "invalid_oauth_state"));
        return;
      }

      const redirectUri = `${apiUrl}/api/auth/github/callback`;
      const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code: query.code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenBody = (await tokenResponse.json()) as GithubTokenResponse;
      if (!tokenBody.access_token) {
        reply.redirect(
          redirectWithError(siteUrl, "oauth_token_exchange_failed"),
        );
        return;
      }

      const userResponse = await fetch(GITHUB_USER_URL, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          accept: "application/json",
          "user-agent": "subzerodev-adventures",
        },
      });
      const user = (await userResponse.json()) as GithubUserResponse;

      await upgradeToGithub(
        pool,
        request,
        reply,
        request.player.playerId,
        String(user.id),
        user.name ?? user.login,
      );
      reply.redirect(siteUrl);
    },
  );
}
