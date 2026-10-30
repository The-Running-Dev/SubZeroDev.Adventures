/**
 * The ten `SessionStore` operations over HTTP, mirroring the upstream MCP server's
 * `createMcpTools` (`engine/src/engine/src/mcp/server.ts`) -- every handler a direct
 * delegation, no game logic in the adapter. Plus `/api/campaigns`, `/api/me`,
 * `/api/auth/logout`, and `/api/saves`, which the store contract has no operation for.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  SessionStoreError,
  type ActionParams,
} from "@the-running-dev/game-engine";
import type { ContentCell } from "../content-cell.js";
import { ContentRefusal } from "../content/admission.js";
import { accessibleIn } from "../content/runtime.js";
import type { EntryRow } from "../content/epoch-store.js";
import {
  catalogEntryOf,
  type CatalogEntry,
} from "../../../shared/campaign-registry.js";
import type { Campaign } from "@the-running-dev/game-engine";
import { requirePrincipal, resolvePrincipal, logout } from "../principal.js";
import { OwnershipError, ownedStore } from "../store/ownedStore.js";
import type { IdentityProvider } from "../identity/provider.js";

const ERROR_STATUS: Record<string, number> = {
  unknown_session: 404,
  unknown_save: 404,
  unknown_campaign: 404,
  storage_failure: 503,
  invalid_state: 409,
  unknown_kind: 409,
  save_requires_migration: 409,
  migration_failed: 409,
  concurrent_modification: 409,
  invalid_fork_point: 409,
  forbidden: 403,
  campaign_access_revoked: 403,
  campaign_version_unsupported: 409,
  campaign_version_unavailable: 409,
  campaign_deleted: 410,
};

function statusFor(code: string): number {
  return ERROR_STATUS[code] ?? 400;
}

/**
 * Authorization is the server's job, not the engine's -- `SessionStore.getScene(id)`
 * would succeed for anyone holding the id. Attaches a store decorated for the calling
 * principal (`store/ownedStore.ts`) so every route below reaches session/save data only
 * through a store that already enforces ownership, rather than through a check a route
 * has to remember to attach for itself.
 *
 * Resolves `cell.current().store` *inside* the handler, not once at registration -- a
 * refresh (#21) swaps the whole `ServerDemo`, engine included, and a request in flight
 * against the old engine would otherwise never see the swap.
 */
function attachStore(pool: Pool, cell: ContentCell) {
  return async (request: FastifyRequest): Promise<void> => {
    const demo = cell.current();
    request.store = ownedStore(
      demo.store,
      pool,
      request.principal.playerId,
      demo,
    );
  };
}

export function registerSessionRoutes(
  app: FastifyInstance,
  pool: Pool,
  cell: ContentCell,
  identityProviders: ReadonlyMap<string, IdentityProvider>,
): void {
  const auth = requirePrincipal(pool);
  // Read-only: resolves an existing session but never mints a guest row, so a bare GET
  // from a crawler or a logged-out browser doesn't grow the `players` table.
  const resolve = resolvePrincipal(pool);
  const owned = attachStore(pool, cell);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof OwnershipError) {
      reply.code(403);
      return reply.send({
        error: { operation: error.operation, code: "forbidden" },
      });
    }
    if (error instanceof ContentRefusal) {
      reply.code(error.status);
      return reply.send({
        error: { operation: error.operation, code: error.code },
      });
    }
    if (error instanceof SessionStoreError) {
      reply.code(statusFor(error.code));
      return reply.send({
        error: { operation: error.operation, code: error.code },
      });
    }
    // A framework-level error (malformed JSON, an empty body Fastify's parser rejects,
    // etc.) already carries its own `statusCode` -- respecting it here rather than always
    // answering 500 is what keeps a client error a 4xx instead of masquerading as a
    // server fault.
    const withStatus = error as { statusCode?: unknown };
    const status =
      typeof withStatus.statusCode === "number" ? withStatus.statusCode : 500;
    request.log.error(error);
    reply.code(status);
    return reply.send({
      error: { operation: "unknown", code: "internal_error" },
    });
  });

  // Hidden-unfiltered within what a viewer may access -- a hidden campaign is reachable via
  // a direct `?campaign=` link (composition.ts), and `BrowserDemo.findCampaign` is
  // synchronous, so the full accessible catalog including hidden entries has to be
  // prefetched here rather than resolved per lookup. `summaries` backs
  // `SessionStore.listCampaigns()`, which the contract requires to be synchronous too
  // (04-core.md) -- the browser's `RemoteSessionStore` cannot fetch it lazily, so it rides
  // along in the same response `createRemoteDemo` already awaits.
  //
  // Access-filtered per viewer since a submission tier exists: `resolve` never mints (a bare
  // GET stays anonymous rather than growing the `players` table), and the response now
  // varies by who's asking, so `Vary: Cookie` -- this was a plain public, cacheable GET
  // before and any intermediary caching it needs to know that changed.
  //
  // Built from the current publication after the request gate (engine plan 54, D4 §1): a
  // closed gate withholds everything but core, and an entry on an epoch this server cannot
  // run is listed as unavailable rather than dropped.
  app.get("/api/campaigns", { preHandler: resolve }, async (request, reply) => {
    const demo = cell.current();
    const playerId = request.principalOrNull?.playerId ?? null;
    const open = await demo.runtime.check();
    const view = demo.runtime.view();
    const listed = (entry: EntryRow) =>
      (open || entry.provenance === null) &&
      accessibleIn([entry], playerId).has(entry.campaignId);
    const entries = (view?.entries ?? []).filter(listed);
    const withheld = (view?.withheld ?? []).filter(listed);
    const owned = (entry: EntryRow, campaign: CatalogEntry): CatalogEntry =>
      entry.provenance === null
        ? campaign
        : {
            ...campaign,
            mine: entry.provenance.ownerPlayerId === playerId,
            visibility: entry.provenance.visibility,
          };
    const available = await Promise.all(
      entries.map(async (entry) =>
        owned(entry, {
          ...catalogEntryOf(
            entry.registry.campaigns.get(entry.campaignId)!,
            entry.registry.strings,
            entry.catalog,
          ),
          offline:
            (await demo.bundleForEpoch(
              entry.campaignId,
              entry.campaignVersion,
            )) !== undefined,
        }),
      ),
    );
    const unavailable = withheld.map((entry) => {
      const { campaign, strings } = entry.epoch.stored.form;
      let listing: CatalogEntry;
      try {
        listing = catalogEntryOf(
          campaign as Campaign,
          new Map(Object.entries(strings)),
          entry.catalog,
        );
      } catch {
        // Content this server's kind cannot read: the catalog's own fields are all it has.
        listing = {
          campaignId: entry.campaignId,
          kindId: campaign.kindId,
          version: entry.campaignVersion,
          ...entry.catalog,
          statBounds: {},
          endingCount: 0,
        };
      }
      return owned(entry, {
        ...listing,
        offline: false,
        available: false,
        code: "campaign_version_unsupported",
      });
    });
    const startable = new Set(entries.map((entry) => entry.campaignId));
    const catalog = await demo.store.listCampaigns();
    reply.header("Vary", "Cookie");
    reply.header("Cache-Control", "private, no-cache");
    return {
      campaigns: [...available, ...unavailable],
      summaries: catalog.campaigns.filter((summary) =>
        startable.has(summary.campaignId),
      ),
    };
  });

  // `signInProvider` is the name `/api/auth/:provider/start` is actually registered under
  // (identity/registry.ts), read here rather than assumed by the frontend -- issue #16.
  // There is only ever one configured provider today; `null` when none is.
  const signInProvider = identityProviders.keys().next().value ?? null;

  app.get("/api/me", { preHandler: resolve }, async (request) => {
    const principal = request.principalOrNull;
    if (!principal)
      return {
        playerId: null,
        kind: "anonymous",
        displayName: null,
        signInProvider,
      };
    return {
      playerId: principal.playerId,
      kind: principal.kind,
      displayName: principal.displayName,
      signInProvider,
    };
  });

  // Logout still needs `auth` (not `resolve`) -- there is nothing useful to log out of an
  // anonymous request, and requiring a real cookie here keeps the route's contract simple.
  app.post("/api/auth/logout", { preHandler: auth }, async (request, reply) => {
    await logout(pool, request, reply);
    return { ok: true };
  });

  app.get("/api/saves", { preHandler: resolve }, async (request) => ({
    saves: request.principalOrNull
      ? await cell.current().store.listSaves(request.principalOrNull.playerId)
      : [],
  }));

  app.delete(
    "/api/saves/:saveId",
    { preHandler: [auth, owned] },
    async (request) => {
      const { saveId } = request.params as { saveId: string };
      const body = request.body as { expectedSavedAt: string };
      await request.store.deleteSave(
        request.principal.playerId,
        saveId,
        body.expectedSavedAt,
      );
      return { ok: true };
    },
  );

  // `[auth, owned]`, not just `auth` -- `owned` is what attaches a store decorated for the
  // access check `ownedStore.createSession` now does (store/ownedStore.ts), so this creates
  // through `request.store` rather than reaching past the decorator to `cell.current().store`
  // directly, which would make that check dead code no request path ever reached.
  app.post("/api/sessions", { preHandler: [auth, owned] }, async (request) => {
    const body = request.body as { campaignId: string; seed?: string };
    return request.store.createSession({
      campaignId: body.campaignId,
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
      audience: "player",
      profileId: request.principal.playerId,
    });
  });

  app.post(
    "/api/sessions/:id/resume",
    { preHandler: [auth, owned] },
    async (request) => {
      const { id } = request.params as { id: string };
      const scene = await request.store.resumeSession(id);
      return { sessionId: id, scene };
    },
  );

  app.get(
    "/api/sessions/:id/scene",
    { preHandler: [auth, owned] },
    async (request) =>
      request.store.getScene((request.params as { id: string }).id),
  );

  app.get(
    "/api/sessions/:id/view",
    { preHandler: [auth, owned] },
    async (request) =>
      request.store.getView((request.params as { id: string }).id),
  );

  app.get(
    "/api/sessions/:id/strings",
    { preHandler: [auth, owned] },
    async (request) =>
      request.store.getStrings((request.params as { id: string }).id),
  );

  app.post(
    "/api/sessions/:id/actions/preview",
    { preHandler: [auth, owned] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { actionId: string; params?: ActionParams };
      return request.store.previewAction(id, body.actionId, body.params);
    },
  );

  app.post(
    "/api/sessions/:id/actions",
    { preHandler: [auth, owned] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { actionId: string; params?: ActionParams };
      return request.store.submitAction(id, body.actionId, body.params);
    },
  );

  app.post(
    "/api/sessions/:id/save",
    { preHandler: [auth, owned] },
    async (request) =>
      request.store.saveGame((request.params as { id: string }).id),
  );

  app.post(
    "/api/saves/:saveId/load",
    { preHandler: [auth, owned] },
    async (request) =>
      request.store.loadGame((request.params as { saveId: string }).saveId),
  );

  // Wire field stays `atSeq` (not the store's own `atActionCount`) -- no reason to break
  // existing callers over an internal rename.
  app.post(
    "/api/sessions/:id/branch",
    { preHandler: [auth, owned] },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { atSeq: number };
      return request.store.branchSession(id, body.atSeq);
    },
  );
}
