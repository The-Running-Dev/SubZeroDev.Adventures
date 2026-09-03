/**
 * `SessionStore` over HTTP -- the browser side of `server/src/routes/session.ts`'s
 * thirteen operations, which mirror the upstream MCP server's `createMcpTools` delegation
 * pattern one-to-one. Every method here is a direct `fetch`, no game logic -- the same
 * "thin adapter" property the in-browser `createInMemorySessionStore` and the local
 * `BrowserClient` already hold.
 *
 * Every request carries `credentials: "include"` so the `httpOnly` guest/player cookie
 * (`server/src/auth.ts`) travels with it -- the server, not this module, is what turns a
 * cookie into a `profileId`.
 */
import {
  SessionStoreError,
  type ActionParams,
  type CampaignCatalog,
  type CampaignSummary,
  type CreateSessionConfig,
  type PlayerView,
  type SaveHandle,
  type SaveSummary,
  type Scene,
  type SessionActionResult,
  type SessionHandle,
  type SessionStore,
  type SessionStoreErrorCode,
  type StringTable,
} from "@the-running-dev/game-engine";

interface ApiErrorBody {
  error?: { operation?: string; code?: string };
}

async function apiFetch<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: "include",
    // Only when there's actually a body -- Fastify's JSON parser rejects a declared
    // `application/json` content-type on an empty body (`FST_ERR_CTP_EMPTY_JSON_BODY`),
    // which several routes here legitimately have (saveGame, resumeSession, loadGame all
    // POST with no payload).
    headers: {
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body: ApiErrorBody | undefined = await response
      .json()
      .catch(() => undefined);
    throw new SessionStoreError(
      body?.error?.operation ?? path,
      (body?.error?.code as SessionStoreErrorCode | undefined) ??
        "storage_failure",
    );
  }
  return (await response.json()) as T;
}

function postJson<T>(
  baseUrl: string,
  path: string,
  payload?: unknown,
): Promise<T> {
  return apiFetch<T>(baseUrl, path, {
    method: "POST",
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/**
 * `listCampaigns()` is session-free but still async on the `SessionStore` contract
 * (`04-core.md`) -- `summaries` is prefetched by whoever composes this store
 * (`composition.ts`'s `createRemoteBrowserDemo`) from the same `/api/campaigns` response
 * the catalog projection comes from, so this wraps it rather than making a second request.
 * `strings` is empty: nothing downstream reads it off this call -- every summary's
 * `titleKey` is already resolved into `CatalogEntry.title` by the server before it reaches
 * `/api/campaigns` (`shared/campaign-registry.ts`'s `buildCatalog`).
 */
export function createRemoteSessionStore(
  baseUrl: string,
  summaries: readonly CampaignSummary[],
): SessionStore {
  return {
    listCampaigns: () =>
      Promise.resolve<CampaignCatalog>({
        campaigns: [...summaries],
        strings: {},
      }),

    listSaves: () =>
      apiFetch<{ saves: SaveSummary[] }>(baseUrl, "/api/saves").then(
        (body) => body.saves,
      ),

    deleteSave: (_profileId, saveId, expectedSavedAt) =>
      apiFetch<{ ok: true }>(baseUrl, `/api/saves/${saveId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedSavedAt }),
      }).then(() => undefined),

    branchSession: (sessionId, atActionCount) =>
      postJson<SessionHandle>(baseUrl, `/api/sessions/${sessionId}/branch`, {
        atSeq: atActionCount,
      }),

    getScene: (sessionId) =>
      apiFetch<Scene>(baseUrl, `/api/sessions/${sessionId}/scene`),
    getView: (sessionId) =>
      apiFetch<PlayerView>(baseUrl, `/api/sessions/${sessionId}/view`),
    getStrings: (sessionId) =>
      apiFetch<StringTable>(baseUrl, `/api/sessions/${sessionId}/strings`),

    previewAction: (sessionId, actionId, params?: ActionParams) =>
      postJson<SessionActionResult>(
        baseUrl,
        `/api/sessions/${sessionId}/actions/preview`,
        {
          actionId,
          params,
        },
      ),

    createSession: (config: CreateSessionConfig) =>
      postJson<SessionHandle>(baseUrl, "/api/sessions", {
        campaignId: config.campaignId,
        ...(config.seed === undefined ? {} : { seed: config.seed }),
      }),

    resumeSession: (sessionId) =>
      postJson<{ sessionId: string; scene: Scene }>(
        baseUrl,
        `/api/sessions/${sessionId}/resume`,
      ).then((result) => result.scene),

    submitAction: (sessionId, actionId, params?: ActionParams) =>
      postJson<SessionActionResult>(
        baseUrl,
        `/api/sessions/${sessionId}/actions`,
        {
          actionId,
          params,
        },
      ),

    saveGame: (sessionId) =>
      postJson<SaveHandle>(baseUrl, `/api/sessions/${sessionId}/save`),

    loadGame: (saveId) =>
      postJson<SessionHandle>(baseUrl, `/api/saves/${saveId}/load`),
  };
}

/** The per-player resume query used at composition time (`composition.ts`), and refreshed
 *  after every `saveGame` -- the same `/api/saves` response `SessionStore.listSaves()`
 *  above wraps, fetched directly here since composition time has no session store yet. */
export async function fetchSaveIndex(
  baseUrl: string,
): Promise<readonly SaveSummary[]> {
  const { saves } = await apiFetch<{ saves: SaveSummary[] }>(
    baseUrl,
    "/api/saves",
  );
  return saves;
}
