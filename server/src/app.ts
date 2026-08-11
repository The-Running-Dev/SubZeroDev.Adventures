import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import { createServerDemo } from "./composition.js";
import { createContentCell } from "./content-cell.js";
import {
  createDiskCampaignSource,
  createHttpCampaignSource,
} from "./campaigns/source.js";
import { registerHealthRoute } from "./health.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerReplayRoutes } from "./routes/replay.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerProgressRoutes } from "./routes/progress.js";
import { registerTransferRoutes } from "./routes/transfer.js";
import { registerBadgeRoutes } from "./routes/badges.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerRankingRoutes } from "./routes/ranking.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { loadIdentityProviders } from "./identity/registry.js";

/** The one place this server reads deployment configuration from -- `index.ts` is the only
 *  caller that reads `process.env` and passes the result in here (issue #12); everything
 *  below, including `routes/identity.ts`, takes it as a parameter instead. */
export interface AppConfig {
  readonly siteUrl: string;
  readonly apiUrl: string;
  /** Undefined means "read content from disk" (`createDiskCampaignSource`'s default) --
   *  the only configuration every test and every non-deployed run needs. Set once content
   *  is actually published somewhere this server can fetch it from. */
  readonly contentBaseUrl?: string;
  /** `provider:subject` pairs, matched against a signed-in principal's linked identities
   *  (`identities` table) to gate `/api/admin/*`. No provider name is ever typed into this
   *  file or `routes/admin.ts` -- these are opaque strings from configuration, the same
   *  posture `identity/registry.ts` already takes (CLAUDE.md, "The Identity Seam"). Absent
   *  or empty means nobody can pass the guard, not that the guard is skipped. */
  readonly adminSubjects?: readonly string[];
}

/** Builds the wired Fastify instance without binding a port -- shared by `index.ts`
 *  (which calls `listen`) and the test suite (which uses `app.inject()`). */
export async function buildApp(
  pool: Pool,
  { siteUrl, apiUrl, contentBaseUrl, adminSubjects = [] }: AppConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  // Fastify's built-in JSON parser rejects a declared `application/json` content-type on
  // an empty body outright (FST_ERR_CTP_EMPTY_JSON_BODY) -- several of this API's own
  // routes are legitimately bodyless POSTs (saveGame, resumeSession, loadGame), so a
  // well-behaved client that always sets the header is enough to trip it. Tolerating an
  // empty body here, rather than relying on every caller to omit the header exactly when
  // there's nothing to send, is the more robust half of the fix.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      if (body === "") return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  await app.register(cookie);
  await app.register(cors, { origin: siteUrl, credentials: true });

  // `SameSite=Lax` only blocks a cross-*site* cookie send -- a sibling subdomain like the
  // blog on *.subzerodev.com is same-site, so its POST would still carry this player's
  // cookie. CORS stops that sibling from *reading* the JSON reply, not from making the
  // write, so this closes the gap CORS leaves open. GET is exempt: it's how the OAuth
  // callback itself arrives, redirected here by the identity provider, which has no
  // Origin header reason to match this site.
  const siteOrigin = new URL(siteUrl).origin;
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== siteOrigin) {
      reply.code(403).send({
        error: { operation: "origin_check", code: "forbidden_origin" },
      });
    }
  });

  // The cell owns the swap: `refresh()` builds a complete `ServerDemo` and only publishes
  // it on success, so a bad rebuild leaves the previous one serving (#22). Every route below
  // takes `cell`, not a `ServerDemo` snapshot, and re-reads `cell.current()` per request.
  const campaignSource = contentBaseUrl
    ? createHttpCampaignSource(contentBaseUrl)
    : createDiskCampaignSource();
  const { cell, ready } = createContentCell(() =>
    createServerDemo(pool, campaignSource),
  );
  await ready();
  registerHealthRoute(app, pool, cell);
  const identityProviders = await loadIdentityProviders();
  registerSessionRoutes(app, pool, cell, identityProviders);
  registerReplayRoutes(app, pool, cell);
  registerIdentityRoutes(app, pool, identityProviders, { siteUrl, apiUrl });
  registerProgressRoutes(app, pool, cell);
  registerTransferRoutes(app, pool);
  registerBadgeRoutes(app, pool, cell);
  registerStatsRoutes(app, pool);
  registerProfileRoutes(app, pool, cell);
  registerRankingRoutes(app, pool);
  registerAdminRoutes(app, pool, cell, adminSubjects);

  return app;
}
