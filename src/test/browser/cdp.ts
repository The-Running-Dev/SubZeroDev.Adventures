import { cdp } from "vitest/browser";

/**
 * `vitest/browser`'s `CDPSession` type is intentionally empty (it varies by
 * provider); the playwright provider's session does implement `send` at
 * runtime. This is the one cast for that, so callers get a typed signature
 * instead of repeating an `as` at every call site.
 */
interface PlaywrightCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

async function session(): Promise<PlaywrightCdpSession> {
  return (await cdp()) as unknown as PlaywrightCdpSession;
}

export interface EmulatedMediaFeature {
  readonly name: string;
  readonly value: string;
}

export async function emulateMedia(
  features: readonly EmulatedMediaFeature[],
): Promise<void> {
  const target = await session();
  await target.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features,
  });
}

export async function clearEmulatedMedia(): Promise<void> {
  await emulateMedia([]);
}
