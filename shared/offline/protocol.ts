import type { PortableCampaign } from "@the-running-dev/game-engine";
import type { Inputs, Frame } from "./runtime-source.js";
export type { Inputs, Frame };
export interface Bundle {
  schema: 1;
  id: string;
  portable: PortableCampaign;
  runtimeId: string;
  runtimeSha256: string;
  engineVersion: string;
  kindId: string;
  kindVersion: string;
  assets: readonly string[];
}
export interface Checkpoint {
  inputs: Inputs;
  blob: string;
  actions: Frame["actions"];
  sessionId: string;
}
export interface Download {
  bundle: Bundle;
  base: string;
  owner: string | null;
  checkpoint?: Checkpoint;
}
export interface SyncRequest {
  schema: 1;
  localRunId: string;
  idempotencyKey: string;
  grant: string;
  base: string;
  bundleId: string;
  runtimeId: string;
  engineVersion: string;
  kindVersion: string;
  inputs: Inputs;
  actions: Frame["actions"];
}
export interface SyncReceipt {
  schema: 1;
  localRunId: string;
  base: string;
  blob: string;
  actionCount: number;
  eligibility: "personal-offline-only";
}
