import { expect, it } from "vitest";
import type { PortableCampaign } from "@the-running-dev/game-engine";
import portable from "../../public/campaigns/getting-started.json";
import { bundleFor, validateBundle } from "./runtime";
import { replay as currentReplay } from "./runtime-source";
it("retains a self-contained runtime which completes a real campaign with identical pinned inputs", () => {
  const bundle = bundleFor(portable as PortableCampaign);
  const runtime = validateBundle(bundle);
  const inputs = {
    gameId: "stable-game",
    seed: "stable-seed",
    audience: "player" as const,
  };
  let frame = runtime.replay(bundle.portable, inputs, []);
  for (let i = 0; frame.scene.status !== "ended" && i < 100; i++) {
    const action = frame.scene.actions.find((a) => a.available);
    expect(action).toBeDefined();
    frame = runtime.advance(bundle.portable, inputs, frame.blob, action!.id);
  }
  expect(frame.scene.status).toBe("ended");
  expect(frame.actions.length).toBeGreaterThan(0);
  expect(runtime.replay(bundle.portable, inputs, frame.actions).blob).toBe(
    frame.blob,
  );
  expect(currentReplay(bundle.portable, inputs, frame.actions).blob).toBe(
    frame.blob,
  );
});
it("reports content corruption without reinterpreting it", () => {
  const bundle = bundleFor(portable as PortableCampaign);
  expect(() =>
    validateBundle({
      ...bundle,
      portable: {
        ...bundle.portable,
        campaign: { ...bundle.portable.campaign, version: "changed" },
      },
    }),
  ).toThrow("incompatible_bundle");
  expect(() => validateBundle({ ...bundle, runtimeId: "missing" })).toThrow(
    "unsupported_runtime",
  );
});
