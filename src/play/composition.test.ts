import { describe, expect, it } from "vitest";
import type { StoredSaveRecord } from "@the-running-dev/game-engine";
import { findLocalSave, localPersistence } from "./composition";

function save(saveId: string, blob: string, savedAt: string): StoredSaveRecord {
  return {
    saveId,
    campaignId: "bureaucracy",
    blob,
    savedAt,
    savedAtSeq: 0,
    audience: "player",
  };
}

const EARLIER = "2026-10-16T00:00:00.000Z";
const LATER = "2026-10-16T00:00:01.000Z";

describe("localPersistence saves", () => {
  // #74: a put() for the same saveId, issued after delete() but landing while delete() was
  // suspended, must survive -- delete() may not erase a record or index entry written after
  // it was called. Same savedAt on both, so only the ordering is under test.
  it("keeps a put() for the same saveId issued while a delete() is in flight", async () => {
    const { saves } = localPersistence();
    await saves.put(save("s1", "old", EARLIER));

    const deleting = saves.delete("s1", EARLIER);
    const writing = saves.put(save("s1", "new", EARLIER));
    await Promise.all([deleting, writing]);

    expect((await saves.get("s1"))?.blob).toBe("new");
    expect(findLocalSave("bureaucracy")).toBe("s1");
  });

  it("leaves a record whose savedAt no longer matches", async () => {
    const { saves } = localPersistence();
    await saves.put(save("s1", "old", EARLIER));
    await saves.put(save("s1", "new", LATER));

    await saves.delete("s1", EARLIER);

    expect((await saves.get("s1"))?.blob).toBe("new");
    expect(findLocalSave("bureaucracy")).toBe("s1");
  });

  it("removes the record and its index entry when savedAt matches", async () => {
    const { saves } = localPersistence();
    await saves.put(save("s1", "old", EARLIER));

    await saves.delete("s1", EARLIER);

    expect(await saves.get("s1")).toBeUndefined();
    expect(findLocalSave("bureaucracy")).toBeUndefined();
  });
});
