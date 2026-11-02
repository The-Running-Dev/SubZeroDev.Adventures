import { registerOfflineRoutes } from "./routes/offline.js";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Pool } from "pg";
import type { SessionLayer } from "@the-running-dev/game-engine";
import {
  createServerDemo,
  createServerDemoFromCurrent,
} from "./composition.js";
import { createContentCell } from "./content-cell.js";
import { createSessionPersistenceCounters } from "./persistence.js";
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
import { registerDiscussionRoutes } from "./routes/discussions.js";
import { registerCaptureRoutes } from "./routes/captures.js";
import {
  DEFAULT_CAPTURE_RETENTION_DAYS,
  faultCapture,
} from "./captures/store.js";
import { sweepExpiredCaptures } from "./maintenance.js";
import {
  backfillDependencies,
  deleteSource,
  reconcileDeletions,
  sweepTombstones,
  type Deletions,
} from "./content/deletion.js";
import { createMemoryLedger, type ExternalLedger } from "./content/ledger.js";
import { contentRuntimeFor } from "./content/runtime.js";
import { loadIdentityProviders } from "./identity/registry.js";
import type { DiscussionForum } from "./discussions/forum.js";

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
   *  has to know which kind it got. `deployment.ts` is where the deployed pair is assembled. */
  readonly campaignSource?: CampaignSource;
  /** Content to boot from when the *first* build off `campaignSource` fails -- see
   *  `content-cell.ts`'s `ready`. The deployed process passes the committed disk snapshot
   *  the image carries (`deployment.ts`'s `createBootstrapCampaignSource`). Undefined
   *  keeps the strict posture (a failed first build throws), which is what a test wants:
   *  there, a build that fails is the thing under test, not an operator locked out of
   *  their own server. */
  readonly bootstrapSource?: CampaignSource;
  /** Undefined means the feature is not configured -- `routes/discussions.ts` answers
   *  `503 not_configured` rather than 404, so the site can tell "off" from "broken", the
   *  same posture identity's `oauth_not_configured` has. `index.ts` is the only caller
   *  that passes one, built by `discussions/registry.ts` from the environment. */
  readonly discussionForum?: DiscussionForum;
  /** The session store's in-memory bound (`composition.ts`'s `SessionCacheOptions`), fed
   *  from `SESSION_CACHE_LIMIT` by `index.ts` through `deployment.ts`. Undefined is
   *  unbounded -- what a test wants, and never what the deployed process passes. */
  readonly sessionCacheLimit?: number;
  /** The external deletion ledger (engine plan 54, D3 §5.3). Undefined is a ledger in this
   *  process's memory -- what a test wants, and never what the deployed process passes:
   *  `deployment.ts` passes the `LEDGER_DATABASE_URL` one, or one that cannot be reached. */
  readonly ledger?: ExternalLedger;
  /** The operator's attested backup retention, in days (D3 §7), which a deletion's
   *  confirmation states. `index.ts` refuses to start without a valid one; undefined only in a
   *  test, where the confirmation leaves it out. */
  readonly backupRetentionDays?: number;
  /** How long a session capture is kept (`CAPTURE_RETENTION_DAYS`, docs/session-capture.md). */
  readonly captureRetentionDays?: number;
}

/**
 * What a request log line carries (engine plan 54, D3 §7): the method and the matched route
 * pattern, never the raw URL. A URL names session, save and source ids, which outlive a
 * deletion in a log nobody purges; a pattern names nothing. An unmatched request logs no path.
 */
export const requestLogSerializers = {
  req: (request: FastifyRequest) => ({
    method: request.method,
    route: request.routeOptions?.url ?? null,
  }),
};

/**
 * Fastify's own 404, without the log line it writes: that line quotes the raw URL, and an
 * unmatched URL can still name a session or source id. The body is the one Fastify sends --
 * it goes back to whoever sent the URL, not into a log.
 */
export function answerNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(404).send({
    message: `Route ${request.method}:${request.url} not found`,
    error: "Not Found",
    statusCode: 404,
  });
}

/** How often the reconciler and the tombstone sweep run (D3 §5.3, §6). */
const RECONCILE_INTERVAL_MS = 60_000;

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
    discussionForum,
    sessionCacheLimit,
    ledger = createMemoryLedger(),
    backupRetentionDays,
    captureRetentionDays = DEFAULT_CAPTURE_RETENTION_DAYS,
  }: AppConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test" && {
      serializers: requestLogSerializers,
    },
  });
  app.setNotFoundHandler(answerNotFound);

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
  //
  // Every build gets the same counters, so the admin status page reports the process, not
  // whichever build happens to be serving.
  //
  // An error-severity event from a session is a fault capture's trigger (docs/session-capture.md):
  // the handler checks its owner's consent, and reports a failure by code alone.
  const captureFault = faultCapture(pool, captureRetentionDays, (message) =>
    app.log.warn(message),
  );
  const sessionCache = {
    sessionCacheLimit,
    counters: createSessionPersistenceCounters(),
    onSessionFault: (layer: SessionLayer, sessionId: string) =>
      void captureFault(layer, sessionId),
  };
  const { cell, ready } = createContentCell(() =>
    createServerDemo(pool, campaignSource, sessionCache),
  );
  // Nothing but core is served until the first reconcile has re-applied the external ledger
  // (engine plan 54, D3 §5.3): a database restored from before a deletion must not serve what
  // was deleted, even for the one request before the reconcile notices.
  const runtime = contentRuntimeFor(pool);
  runtime.hold();
  // The fallback covers the *first* build only, and it exists so unusable content an
  // operator added cannot keep the server from starting -- the admin routes below are the
  // only way to remove that content, so they have to come up. See `ready`. What is already
  // current comes first (engine plan 54, §3.3): it needs no source at all, so a boot no longer
  // depends on one being reachable, and the bootstrap snapshot is only the very first boot's,
  // before anything has been published.
  await ready(async () => {
    try {
      return await createServerDemoFromCurrent(pool, sessionCache);
    } catch (error) {
      if (!bootstrapSource) throw error;
      return createServerDemo(pool, bootstrapSource, sessionCache);
    }
  });
  const warn = (message: string, error?: unknown) =>
    app.log.warn({ err: error }, message);
  // One reconcile at a time in this process; `reconcileDeletions` takes the lock across
  // processes. Done is what reopens the gate, after a boot or a restore; anything else leaves it
  // as it was until the next attempt.
  let reconciling: Promise<void> | undefined;
  const reconcile = (): Promise<void> =>
    (reconciling ??= (async () => {
      try {
        if ((await reconcileDeletions(pool, ledger, warn)) === "done")
          await runtime.release();
      } catch (error) {
        warn("deletion reconcile failed", error);
      } finally {
        reconciling = undefined;
      }
    })());
  runtime.onRestore(() => void reconcile());
  await backfillDependencies(pool, (message) => warn(message));
  await reconcile();
  const timer = setInterval(() => {
    void reconcile();
    void sweepTombstones(pool).catch((error: unknown) =>
      warn("tombstone sweep failed", error),
    );
    void sweepExpiredCaptures(pool).catch((error: unknown) =>
      warn("capture sweep failed", error),
    );
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    await reconciling;
    await ledger.close();
  });
  const deletions: Deletions = {
    async remove(sourceId, actor) {
      const outcome = await deleteSource(pool, ledger, sourceId, actor, warn);
      void reconcile();
      return outcome;
    },
    backupRetentionDays,
  };

  registerHealthRoute(app, pool, cell);
  const identityProviders = await loadIdentityProviders();
  registerSessionRoutes(app, pool, cell, identityProviders);
  registerReplayRoutes(app, pool, cell);
  registerOfflineRoutes(app, pool, cell);
  registerIdentityRoutes(app, pool, identityProviders, { siteUrl, apiUrl });
  registerProgressRoutes(app, pool, cell);
  registerTransferRoutes(app, pool);
  registerBadgeRoutes(app, pool, cell);
  registerStatsRoutes(app, pool);
  registerProfileRoutes(app, pool, cell);
  registerRankingRoutes(app, pool, cell);
  registerAdminRoutes(app, pool, cell, campaignSource, sessionCache, deletions);
  registerContentRoutes(app, pool, cell, deletions);
  registerDiscussionRoutes(app, pool, discussionForum);
  registerCaptureRoutes(app, pool, cell, captureRetentionDays);

  return app;
}
