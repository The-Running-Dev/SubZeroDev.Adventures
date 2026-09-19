/**
 * The landing wizard's one bit of state, split out of `composition.ts` deliberately: the
 * router decides on every load whether a visitor is new (`app/routes.tsx`), and importing
 * that decision from `composition.ts` would pull the engine, the campaign registry and the
 * remote store into the eager bundle the whole site waits on.
 */

export function browserStorageAvailable(): boolean {
  try {
    const probe = "subzerodev.play.storage-probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

const ONBOARDING_SEEN_KEY = "subzerodev.play.onboarding-seen.v1";

/** Whether the landing wizard has already run (or been skipped) in this browser. Storage
 *  being unavailable is treated as "seen" -- there is nowhere to remember "skipped" in that
 *  environment, and re-showing it on every load would be worse than never showing it. */
export function hasSeenOnboarding(): boolean {
  if (!browserStorageAvailable()) return true;
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markOnboardingSeen(): void {
  if (!browserStorageAvailable()) return;
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // Nothing to fall back to -- the wizard may simply run again next load.
  }
}
