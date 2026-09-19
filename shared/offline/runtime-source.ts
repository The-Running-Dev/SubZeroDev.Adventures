/** Source of the retained runtime artifact. Never execute this source for an old run. */
import {
  createEngine,
  digestPortableCampaign,
  ENGINE_VERSION,
  type GameState,
  type PortableCampaign,
  type Scene,
} from "@the-running-dev/game-engine";
import { buildCatalog, KINDS } from "../campaign-registry.js";
export interface Inputs {
  gameId: string;
  seed: string;
  audience: "player";
}
export interface Frame {
  blob: string;
  scene: Scene;
  actions: GameState["actionLog"];
  strings: Record<string, string>;
}
export function inspect(portable: PortableCampaign) {
  if (
    portable.formatVersion !== 2 ||
    portable.campaign.kindId !== "story-graph" ||
    KINDS["story-graph"].profileData
  )
    throw new Error("unsupported_campaign");
  buildCatalog([portable]);
  return {
    digest: digestPortableCampaign(portable),
    engineVersion: ENGINE_VERSION,
    kindId: "story-graph",
    kindVersion: KINDS["story-graph"].version,
    assets: [] as string[],
  };
}
function engineFor(portable: PortableCampaign, inputs: Inputs) {
  inspect(portable);
  const { registry } = buildCatalog([portable]);
  return {
    engine: createEngine({
      kinds: KINDS,
      registry,
      ids: {
        newGameId: () => inputs.gameId,
        newSeed: () => {
          throw Error("missing_seed");
        },
      },
    }),
    registry,
  };
}
export function replay(
  portable: PortableCampaign,
  inputs: Inputs,
  actions: GameState["actionLog"],
): Frame {
  const { engine, registry } = engineFor(portable, inputs);
  const created = engine.createGame({
    campaignId: portable.campaign.id,
    seed: inputs.seed,
    audience: inputs.audience,
  });
  if (!created.ok || !created.value) throw Error("invalid_initialization");
  let state = created.value;
  for (const [index, action] of actions.entries()) {
    if (action.seq !== index) throw Error("invalid_actions");
    const result = engine.submitAction(state, action.actionId, action.params);
    if (!result.ok || !result.value) throw Error("invalid_actions");
    state = result.value;
  }
  return {
    blob: engine.serialize(state),
    scene: engine.scene(state),
    actions: state.actionLog,
    strings: Object.fromEntries(registry.strings),
  };
}
export function advance(
  portable: PortableCampaign,
  inputs: Inputs,
  blob: string,
  actionId: string,
): Frame {
  const { engine, registry } = engineFor(portable, inputs);
  const restored = engine.deserialize(blob);
  if (
    !restored.ok ||
    !restored.value ||
    restored.value.gameId !== inputs.gameId ||
    restored.value.seed !== inputs.seed
  )
    throw Error("invalid_recovery");
  const result = engine.submitAction(restored.value, actionId);
  if (!result.ok || !result.value) throw Error("invalid_actions");
  return {
    blob: engine.serialize(result.value),
    scene: engine.scene(result.value),
    actions: result.value.actionLog,
    strings: Object.fromEntries(registry.strings),
  };
}
