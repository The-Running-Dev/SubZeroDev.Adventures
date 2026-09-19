import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import portable from "../../public/campaigns/what-would-lucifer-do.json";
import code from "../../shared/offline/runtimes/b7e21e712a1e72e32d327ecebac72a2af1c27ebd.mjs?raw";
import { bundleFor, validateBundle } from "../../shared/offline/runtime";
import {
  advanceLocal,
  downloadCampaign,
  recover,
  startLocal,
  synchronize,
} from "./adapter";
import {
  DB_NAME,
  records,
  removeRecord,
  type LocalRun,
  type SavedDownload,
} from "./database";
import type { Download, SyncRequest } from "../../shared/offline/protocol";
const owner = "10000000-0000-4000-8000-000000000001",
  api = "https://api.invalid",
  scope = `${api}|${owner}`;
let download: Download;
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
  download = {
    bundle: bundleFor(portable as PortableCampaign),
    base: crypto.randomUUID(),
    owner,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/api/offline/download/")
        ? Response.json(download)
        : new Response(code),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
async function ready() {
  return downloadCampaign(api, scope, portable.campaign.id, () => {});
}
it("downloads all requirements before ready, commits a move and recovers without any network", async () => {
  const d = await ready();
  expect(await records<SavedDownload>("downloads", scope)).toHaveLength(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(Error("outbound blocked"))),
  );
  const run = await startLocal(d);
  const advanced = await advanceLocal(run, "laugh");
  const persisted = (await records<LocalRun>("runs", scope))[0]!;
  expect(persisted.blob).toBe(advanced.blob);
  expect((await recover(persisted)).actions).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
  await removeRecord("downloads", scope, d.key);
  expect(await records("downloads", scope)).toHaveLength(0);
  expect(
    (await recover((await records<LocalRun>("runs", scope))[0]!)).blob,
  ).toBe(advanced.blob);
});
it("never marks partial content, missing code or incompatible assets ready", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/api/")
        ? Response.json(download)
        : new Response("broken"),
    ),
  );
  await expect(ready()).rejects.toThrow("missing_runtime");
  expect(await records("downloads", scope)).toEqual([]);
  download.bundle = { ...download.bundle, assets: ["missing.png"] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/api/")
        ? Response.json(download)
        : new Response(code),
    ),
  );
  await expect(ready()).rejects.toThrow("incompatible_bundle");
  expect(await records("downloads", scope)).toEqual([]);
});
it("rejects a stale tab and simultaneous writers without duplicating an action", async () => {
  const run = await startLocal(await ready());
  const outcomes = await Promise.allSettled([
    advanceLocal(run, "laugh"),
    advanceLocal(run, "laugh"),
  ]);
  expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  await expect(advanceLocal(run, "laugh")).rejects.toThrow("stale_tab");
  expect(
    (await recover((await records<LocalRun>("runs", scope))[0]!)).actions,
  ).toHaveLength(1);
});
it("leaves the previous save intact on quota failure", async () => {
  const run = await startLocal(await ready());
  const put = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
  await expect(advanceLocal(run, "laugh")).rejects.toBeDefined();
  put.mockRestore();
  expect((await records<LocalRun>("runs", scope))[0]?.blob).toBe(run.blob);
});
it("persists the exact sync request before a lost response and retries that key", async () => {
  const run = await advanceLocal(await startLocal(await ready()), "laugh");
  let submitted: SyncRequest | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      throw Error("response lost after commit");
    }),
  );
  await expect(synchronize(api, owner, run)).rejects.toBeDefined();
  const retry = (await records<LocalRun>("runs", scope))[0]!;
  expect(retry.pending).toEqual(submitted);
  const authoritative = validateBundle(download.bundle).replay(
    download.bundle.portable,
    run.inputs,
    submitted!.actions,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(submitted);
      return Response.json({
        schema: 1,
        localRunId: run.id,
        base: crypto.randomUUID(),
        blob: authoritative.blob,
        actionCount: 1,
        eligibility: "personal-offline-only",
      });
    }),
  );
  const synced = await synchronize(api, owner, retry);
  expect(synced.pending).toBeUndefined();
  expect(synced.syncedCount).toBe(1);
  expect(synced.blob).toBe(authoritative.blob);
});
it("keeps guest/account histories separate and refuses upload under another account", async () => {
  const run = await startLocal(await ready());
  expect(await records("runs", `${api}|guest`)).toEqual([]);
  expect(await records("runs", `${api}|another`)).toEqual([]);
  await expect(synchronize(api, null, run)).rejects.toThrow("member_required");
  await expect(synchronize(api, "another", run)).rejects.toThrow(
    "member_required",
  );
  download = { ...download, owner: null };
  const d = await downloadCampaign(
    api,
    `${api}|guest`,
    portable.campaign.id,
    () => {},
  );
  const guest = await startLocal(d);
  await expect(synchronize(api, owner, guest)).rejects.toThrow(
    "member_required",
  );
});
it("keeps pinned inputs across recovery and fails explicitly when historical runtime is missing", async () => {
  const run = await advanceLocal(await startLocal(await ready()), "laugh");
  expect(JSON.parse((await recover(run)).blob).gameId).toBe(run.inputs.gameId);
  const broken = { ...run, download: { ...run.download, runtimeCode: "" } };
  await expect(recover(broken)).rejects.toThrow("missing_runtime");
  const wrong = {
    ...run,
    download: {
      ...run.download,
      bundle: { ...run.download.bundle, runtimeId: "old-unavailable" },
    },
  };
  await expect(recover(wrong)).rejects.toThrow("unsupported_runtime");
  expect((await records<LocalRun>("runs", scope))[0]?.blob).toBe(run.blob);
});
