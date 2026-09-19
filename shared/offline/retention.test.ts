import { expect, it, vi } from "vitest";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import portable from "../../public/campaigns/getting-started.json";
// Simulate a later application's current selection. Historical dispatch must not move.
vi.mock("./runtime-id.js", () => ({
  RUNTIME_ID: "future-unregistered",
  RUNTIME_SHA256: "future",
}));
import { bundleFor, validateBundle } from "./runtime.js";
import { knownRuntimeHashes } from "./known-runtimes.js";
import * as historical from "./runtimes/b7e21e712a1e72e32d327ecebac72a2af1c27ebd.mjs";
it("retains an older compatible runtime independently of a later current selection", () => {
  const content = portable as PortableCampaign;
  const info = historical.inspect(content);
  const id = "b7e21e712a1e72e32d327ecebac72a2af1c27ebd";
  const bundle = {
    schema: 1 as const,
    id: info.digest,
    portable: content,
    runtimeId: id,
    runtimeSha256: knownRuntimeHashes[id]!,
    ...info,
  };
  expect(validateBundle(bundle)).toBe(historical);
  // A new selection must be explicitly registered; it cannot relabel old code.
  expect(() => bundleFor(content)).toThrow("unsupported_runtime");
});
