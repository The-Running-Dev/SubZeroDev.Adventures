import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import { createServerDemo } from "./composition.js";
import { createContentCell } from "./content-cell.js";
import {
  createDiskCampaignSource,
  type CampaignSource,
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
import { registerContentRoutes } from "./routes/content.js";
import { loadIdentityProviders } from "./identity/registry.js";

/** The one place this server reads deployment configuration from -- `index.ts` is the only
 *  caller that reads `process.env` and passes the result in here (issue #12); everything
 *  below, including `routes/identity.ts`, takes it as a parameter instead. */
export interface AppConfig {
  readonly siteUrl: string;
  readonly apiUrl: string;
  /** Extra browser origins allowed alongside `siteUrl` -- a tunnelled preview host or a
   *  local `vite dev` (docs/preview.md), fed from `PREVIEW_ORIGINS` by `index.ts`.
   *
   *  Deliberately a second field rather than making `siteUrl` a list: `siteUrl` is also
   *  the post-OAuth redirect target (`routes/identity.ts`) and the thing `deploy.yml`
   *  builds the site against, and both of those have to keep resolving to exactly one
   *  answer. Widening the CORS allowlist is the only thing a preview origin is entitled
   *  to; it does not become a site this server will redirect a browser to. */
  readonly previewOrigins?: readonly string[];
  /** Undefined means `createDiskCampaignSource()` -- the only configuration every test and
   *  every non-deployed run needs, and it never touches the network or the
   *  `content_sources` table. `index.ts` is the only caller that passes something else: a
   *  multi-source `CampaignSource` (`campaigns/multi-source.ts`) built around the hardcoded
   *  default plus whatever an admin has added (issue #27). Injectable for the same reason
   *  `createServerDemo`'s own `campaignSource` parameter is (#12) -- so this file never
   *  has to know which kind it got. */
  readonly campaignSource?: CampaignSource;
  /** Content to boot from when the *first* build off `campaignSource` fails -- see
   *  `content-cell.ts`'s `ready`. `index.ts` passes the committed disk snapshot. Undefined
   *  keeps the strict posture (a failed first build throws), which is what a test wants:
   *  there, a build that fails is the thing under test, not an operator locked out of
   *  their own server. */
  readonly bootstrapSource?: CampaignSource;
}

/** Builds the wired Fastify instance without binding a port -- shared by `index.ts`
 *  (which calls `listen`) and the test suite (which uses `app.inject()`). */
export async function buildApp(
  pool: Pool,
  {
    siteUrl,
    apiUrl,
    previewOrigins = [],
    campaignSource = createDiskCampaignSource(),
    bootstrapSource,
  }: AppConfig,
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
  // The canonical site plus any opt-in preview origins (see `AppConfig.previewOrigins`).
  // Normalized through `URL` so a configured value carrying a trailing slash or a path
  // still compares equal to the bare `Origin` header a browser actually sends -- the raw
  // string this used to pass would have silently failed to match one.
  const allowedOrigins = [siteUrl, ...previewOrigins].map(
    (url) => new URL(url).origin,
  );
  // `@fastify/cors`'s own default `methods` is `GET,HEAD,POST` -- unlike the vanilla `cors`
  // package it's modeled on, it does not include DELETE. Left implicit, that silently blocks
  // the preflight for `DELETE /api/admin/content/sources/:id` (admin.ts) with no error this
  // server ever sees -- the browser refuses to send the real request at all. Listed
  // explicitly here so it tracks the methods this API actually exposes, not the plugin's.
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "DELETE"],
  });

  // `SameSite=Lax` only blocks a cross-*site* cookie send -- a sibling subdomain like the
  // blog on *.subzerodev.com is same-site, so its POST would still carry this player's
  // cookie. CORS stops that sibling from *reading* the JSON reply, not from making the
  // write, so this closes the gap CORS leaves open. GET is exempt: it's how the OAuth
  // callback itself arrives, redirected here by the identity provider, which has no
  // Origin header reason to match this site.
  //
  // A preview origin is trusted for writes too, not just for reads: it is a build of this
  // same site, and a preview that could read state but not save a game would be testing
  // something other than what ships. That is the whole cost of `PREVIEW_ORIGINS` -- every
  // origin listed there can act as the player, so it is an operator-set variable and never
  // anything a request can influence.
  const writeableOrigins = new Set(allowedOrigins);
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const origin = request.headers.origin;
    if (origin !== undefined && !writeableOrigins.has(origin)) {
      reply.code(403).send({
        error: { operation: "origin_check", code: "forbidden_origin" },
      });
    }
  });

  // The cell owns the swap: `refresh()` builds a complete `ServerDemo` and only publishes
  // it on success, so a bad rebuild leaves the previous one serving (#22). Every route below
  // takes `cell`, not a `ServerDemo` snapshot, and re-reads `cell.current()` per request.
  const { cell, ready } = createContentCell(() =>
    createServerDemo(pool, campaignSource),
  );
  // The fallback covers the *first* build only, and it exists so unusable content an
  // operator added cannot keep the server from starting -- the admin routes below are the
  // only way to remove that content, so they have to come up. See `ready`.
  await ready(
    bootstrapSource ? () => createServerDemo(pool, bootstrapSource) : undefined,
  );
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
  registerRankingRoutes(app, pool, cell);
  registerAdminRoutes(app, pool, cell, campaignSource);
  registerContentRoutes(app, pool, cell);

  return app;
}
