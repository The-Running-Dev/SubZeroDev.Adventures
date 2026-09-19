// Historical dispatch is additive. Do not replace an old runtime with current source.
import * as v1 from "./runtimes/b7e21e712a1e72e32d327ecebac72a2af1c27ebd.mjs";
import { RUNTIME_ID, RUNTIME_SHA256 } from "./runtime-id.js";
import type { Bundle } from "./protocol.js";
import type { PortableCampaign } from "@the-running-dev/game-engine";
export const runtimes: Readonly<Record<string, typeof v1>> = {
  [RUNTIME_ID]: v1,
};
export function bundleFor(portable: PortableCampaign): Bundle {
  const info = v1.inspect(portable);
  return {
    schema: 1,
    id: info.digest,
    portable,
    runtimeId: RUNTIME_ID,
    runtimeSha256: RUNTIME_SHA256,
    ...info,
  };
}
export function validateBundle(bundle: Bundle) {
  const runtime = runtimes[bundle.runtimeId];
  if (!runtime) throw Error("unsupported_runtime");
  const info = runtime.inspect(bundle.portable);
  if (
    bundle.schema !== 1 ||
    info.digest !== bundle.id ||
    bundle.engineVersion !== info.engineVersion ||
    bundle.kindId !== info.kindId ||
    bundle.kindVersion !== info.kindVersion ||
    bundle.runtimeSha256 !== RUNTIME_SHA256 ||
    bundle.assets.length !== 0
  )
    throw Error("incompatible_bundle");
  return runtime;
}
