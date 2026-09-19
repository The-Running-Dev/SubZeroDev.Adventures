import { request } from "../api/client";
import { knownRuntimeHashes } from "../../shared/offline/known-runtimes";
import type * as Runtime from "../../shared/offline/runtime-source";
import type {
  Bundle,
  Download,
  Frame,
  SyncReceipt,
  SyncRequest,
} from "../../shared/offline/protocol";
import {
  records,
  writeRecord,
  type LocalRun,
  type SavedDownload,
} from "./database";
const modules = new Map<string, typeof Runtime>();
const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
export async function loadRuntime(
  bundle: Bundle,
  code: string,
): Promise<typeof Runtime> {
  if (
    !knownRuntimeHashes[bundle.runtimeId] ||
    bundle.runtimeSha256 !== knownRuntimeHashes[bundle.runtimeId]
  )
    throw Error("unsupported_runtime");
  if ((await sha256(code)) !== bundle.runtimeSha256)
    throw Error("missing_runtime");
  const url = URL.createObjectURL(
    new Blob([code], { type: "text/javascript" }),
  );
  try {
    const runtime =
      modules.get(bundle.runtimeId) ??
      ((await import(/* @vite-ignore */ url)) as typeof Runtime);
    modules.set(bundle.runtimeId, runtime);
    const info = runtime.inspect(bundle.portable);
    if (
      bundle.schema !== 1 ||
      info.digest !== bundle.id ||
      info.engineVersion !== bundle.engineVersion ||
      info.kindVersion !== bundle.kindVersion ||
      info.kindId !== bundle.kindId ||
      bundle.assets.length
    )
      throw Error("incompatible_bundle");
    return runtime;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function downloadCampaign(
  api: string | undefined,
  scope: string,
  campaignId: string,
  onProgress: (value: number) => void,
  sessionId?: string,
): Promise<SavedDownload> {
  onProgress(0);
  const download = await request<Download>(
    api,
    `/api/offline/download/${encodeURIComponent(campaignId)}`,
    { method: "POST", body: sessionId ? { sessionId } : {} },
  );
  if (scope !== `${api ?? "local"}|${download.owner ?? "guest"}`)
    throw Error("account_changed");
  onProgress(30);
  const response = await fetch(
    `/assets/offline-${download.bundle.runtimeId}.js`,
    { credentials: "omit" },
  );
  if (!response.ok) throw Error("missing_runtime");
  const runtimeCode = await response.text();
  onProgress(70);
  const runtime = await loadRuntime(download.bundle, runtimeCode);
  if (download.checkpoint) {
    const check = runtime.replay(
      download.bundle.portable,
      download.checkpoint.inputs,
      download.checkpoint.actions,
    );
    if (check.blob !== download.checkpoint.blob)
      throw Error("invalid_checkpoint");
  }
  const value: SavedDownload = {
    ...download,
    key: `${scope}|${campaignId}`,
    scope,
    runtimeCode,
  };
  await writeRecord("downloads", value);
  onProgress(100);
  return value;
}
export async function startLocal(download: SavedDownload): Promise<LocalRun> {
  const runtime = await loadRuntime(download.bundle, download.runtimeCode);
  const inputs = download.checkpoint?.inputs ?? {
    gameId: crypto.randomUUID(),
    seed: crypto.randomUUID(),
    audience: "player" as const,
  };
  const frame = runtime.replay(
    download.bundle.portable,
    inputs,
    download.checkpoint?.actions ?? [],
  );
  const id = crypto.randomUUID();
  const run: LocalRun = {
    schema: 1,
    id,
    key: `${download.scope}|${id}`,
    scope: download.scope,
    download,
    inputs,
    blob: frame.blob,
    revision: 0,
    base: download.base,
    syncedCount: -1,
  };
  await writeRecord("runs", run);
  return run;
}
export async function recover(run: LocalRun): Promise<Frame> {
  const runtime = await loadRuntime(
    run.download.bundle,
    run.download.runtimeCode,
  );
  const stored = JSON.parse(run.blob);
  const frame = runtime.replay(
    run.download.bundle.portable,
    run.inputs,
    stored.actionLog,
  );
  if (frame.blob !== run.blob) throw Error("invalid_recovery");
  return frame;
}
async function locked<T>(
  run: LocalRun,
  operation: (fresh: LocalRun) => Promise<T>,
): Promise<T> {
  if (!navigator.locks) throw Error("locking_unavailable");
  return navigator.locks.request(
    `adventures:${run.key}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw Error("busy_tab");
      const fresh = (await records<LocalRun>("runs", run.scope)).find(
        (x) => x.id === run.id,
      );
      if (!fresh || fresh.revision !== run.revision) throw Error("stale_tab");
      return operation(fresh);
    },
  );
}
export async function advanceLocal(
  run: LocalRun,
  actionId: string,
): Promise<LocalRun> {
  return locked(run, async (fresh) => {
    const runtime = await loadRuntime(
      fresh.download.bundle,
      fresh.download.runtimeCode,
    );
    if (JSON.parse(fresh.blob).actionLog.length >= 5000)
      throw Error("action_limit");
    const frame = runtime.advance(
      fresh.download.bundle.portable,
      fresh.inputs,
      fresh.blob,
      actionId,
    );
    const next = { ...fresh, blob: frame.blob, revision: fresh.revision + 1 };
    await writeRecord("runs", next, fresh.revision);
    return next;
  });
}
export async function synchronize(
  api: string | undefined,
  member: string | null,
  run: LocalRun,
): Promise<LocalRun> {
  if (
    !member ||
    run.download.owner !== member ||
    run.scope !== `${api}|${member}`
  )
    throw Error("member_required");
  return locked(run, async (fresh) => {
    const bundle = fresh.download.bundle;
    const pending: SyncRequest = fresh.pending ?? {
      schema: 1,
      localRunId: fresh.id,
      idempotencyKey: crypto.randomUUID(),
      grant: fresh.download.base,
      base: fresh.base,
      bundleId: bundle.id,
      runtimeId: bundle.runtimeId,
      engineVersion: bundle.engineVersion,
      kindVersion: bundle.kindVersion,
      inputs: fresh.inputs,
      actions: JSON.parse(fresh.blob).actionLog,
    };
    // Persist the exact request before sending; retries cannot accidentally mint a new key.
    const prepared = { ...fresh, pending, revision: fresh.revision + 1 };
    await writeRecord("runs", prepared, fresh.revision);
    const receipt = await request<SyncReceipt>(api, "/api/offline/sync", {
      method: "POST",
      body: pending,
    });
    const runtime = await loadRuntime(bundle, fresh.download.runtimeCode);
    if (
      receipt.schema !== 1 ||
      receipt.eligibility !== "personal-offline-only" ||
      receipt.actionCount !== pending.actions.length ||
      typeof receipt.base !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(receipt.base) ||
      receipt.localRunId !== fresh.id ||
      receipt.blob !==
        runtime.replay(bundle.portable, fresh.inputs, pending.actions).blob
    )
      throw Error("invalid_response");
    const next = {
      ...prepared,
      pending: undefined,
      receipt,
      base: receipt.base,
      syncedCount: receipt.actionCount,
      revision: prepared.revision + 1,
    };
    await writeRecord("runs", next, prepared.revision);
    return next;
  });
}
