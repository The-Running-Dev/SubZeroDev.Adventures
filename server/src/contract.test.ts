/**
 * Asserts this server still matches the published service contract
 * (`@subzerodev/service-contract`, vendored in `vendor/` -- see issue #12/#13 for why:
 * nothing else would notice an operation renamed, dropped, or added on either side).
 *
 * `SERVED_STORE_METHODS` is exhaustive by construction: it types as
 * `Record<keyof SessionStore, true>`, so adding, removing, or renaming a `SessionStore`
 * method is a compile error here unless this object is updated to match -- that is the
 * static half of "the operations the server serves." `routes/session.ts`'s
 * `registerSessionRoutes` forwards every one of these directly to `request.store.<name>()`
 * (`store: SessionStore = demo.store`), so the keys of this object are exactly the store
 * methods reachable from that route registration, not a second, hand-maintained guess at
 * it. The dynamic half, below, is comparing that set against the contract package's own
 * `operations` -- so a contract bump that renames or drops an operation fails this test
 * even though nothing here changed.
 */
import { describe, expect, it } from "vitest";
import { loadPublishedContract } from "@subzerodev/service-contract";
import type { SessionStore } from "@the-running-dev/game-engine";

const SERVED_STORE_METHODS: Record<keyof SessionStore, true> = {
  listCampaigns: true,
  getScene: true,
  getView: true,
  getStrings: true,
  listSaves: true,
  previewAction: true,
  createSession: true,
  resumeSession: true,
  submitAction: true,
  saveGame: true,
  loadGame: true,
  deleteSave: true,
  branchSession: true,
};

describe("service contract conformance", () => {
  it("serves exactly the operations the published contract declares", () => {
    const contract = loadPublishedContract();
    const contractMethods = contract.operations
      .map((operation) => operation.storeMethod)
      .sort();
    const servedMethods = Object.keys(SERVED_STORE_METHODS).sort();

    expect(servedMethods).toEqual(contractMethods);
  });
});
