import type {
  Download,
  Inputs,
  SyncRequest,
  SyncReceipt,
} from "../../shared/offline/protocol";
export const DB_NAME = "subzerodev-offline-v1";
export interface SavedDownload extends Download {
  key: string;
  scope: string;
  runtimeCode: string;
}
export interface LocalRun {
  schema: 1;
  key: string;
  scope: string;
  id: string;
  download: SavedDownload;
  inputs: Inputs;
  blob: string;
  revision: number;
  base: string;
  syncedCount: number;
  pending?: SyncRequest;
  receipt?: SyncReceipt;
}
export async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      for (const name of ["downloads", "runs"])
        request.result.createObjectStore(name, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error("storage_failed"));
    request.onblocked = () => reject(Error("storage_blocked"));
  });
}
export async function records<T extends { scope: string }>(
  store: "runs" | "downloads",
  scope: string,
): Promise<T[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () =>
        resolve((request.result as T[]).filter((x) => x.scope === scope));
      request.onerror = () => reject(Error("storage_failed"));
    });
  } finally {
    db.close();
  }
}
/** One transaction includes log, recovery blob and revision; never show a saved state first. */
export async function writeRecord(
  store: "runs" | "downloads",
  value: LocalRun | SavedDownload,
  expectedRevision?: number,
): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      let conflict = false;
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(Error(conflict ? "stale_tab" : "storage_failed"));
      tx.onerror = () => {};
      const put = () => {
        try {
          os.put(value);
        } catch {
          tx.abort();
        }
      };
      if (expectedRevision === undefined) put();
      else {
        const read = os.get(value.key);
        read.onsuccess = () => {
          if (read.result?.revision !== expectedRevision) {
            conflict = true;
            tx.abort();
          } else put();
        };
      }
    });
  } finally {
    db.close();
  }
}
export async function removeRecord(
  store: "runs" | "downloads",
  scope: string,
  key: string,
): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      const read = os.get(key);
      read.onsuccess = () => {
        if (read.result?.scope === scope) os.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(Error("storage_failed"));
    });
  } finally {
    db.close();
  }
}
