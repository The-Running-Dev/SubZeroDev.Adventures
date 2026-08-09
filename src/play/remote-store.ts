/**
 * `SessionStore` over HTTP -- the browser side of the server's ten routes
 * (`server/src/routes/session.ts`), which mirror the upstream MCP server's
 * `createMcpTools` delegation pattern one-to-one. Every method here is a direct `fetch`,
 * no game logic -- the same "thin adapter" property the in-browser
 * `createInMemorySessionStore` and the local `BrowserClient` already hold.
 *
 * Every request carries `credentials: "include"` so the `httpOnly` guest/player cookie
 * (`server/src/auth.ts`) travels with it -- the server, not this module, is what turns a
 * cookie into a `profileId`.
 */
import {
  SessionStoreError,
  type ActionParams,
  type CampaignSummary,
  type CreateSessionConfig,
  type PlayerView,
  type SaveHandle,
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
 * `listCampaigns()` is synchronous on the `SessionStore` contract (`04-core.md`), so it
 * cannot itself be a network call -- `summaries` is prefetched by whoever composes this
 * store (`composition.ts`'s `createRemoteDemo`) from the same `/api/campaigns` response
 * the catalog projection comes from.
 */
export function createRemoteSessionStore(
  baseUrl: string,
  summaries: readonly CampaignSummary[],
): SessionStore {
  return {
    listCampaigns: () => [...summaries],

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

export interface RemoteSave {
  readonly saveId: string;
  readonly campaignId: string;
  readonly savedAtSeq: number;
}

/** The per-player resume query `SessionStore` has no operation for -- fetched once at
 *  composition time and refreshed after every `saveGame` (`composition.ts`). */
export async function fetchSaveIndex(
  baseUrl: string,
): Promise<readonly RemoteSave[]> {
  const { saves } = await apiFetch<{ saves: RemoteSave[] }>(
    baseUrl,
    "/api/saves",
  );
  return saves;
}
