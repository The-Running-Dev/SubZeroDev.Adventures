import { useSyncExternalStore } from "react";
const subscribe = (notify: () => void) => {
  navigator.serviceWorker?.addEventListener("controllerchange", notify);
  return () =>
    navigator.serviceWorker?.removeEventListener("controllerchange", notify);
};
/** Downloads promise cold offline launch, so wait for the fully precached shell. */
export function useOfflineShellReady() {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(navigator.serviceWorker?.controller),
    () => false,
  );
}
