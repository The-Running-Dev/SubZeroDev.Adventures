import { useSyncExternalStore } from "react";
import type { Identity } from "../play/identity";
import { useAccount } from "../app/providers/AccountProvider";
import { useOnline } from "../pwa/usePwa";
const key = (api: string | undefined) =>
  `subzerodev.offline-owner.v1:${api ?? ""}`;
const notify = () => window.dispatchEvent(new Event("offline-owner-changed"));
export function rememberOfflineIdentity(
  api: string | undefined,
  identity: Identity,
) {
  try {
    if (identity.kind === "member" && identity.playerId)
      localStorage.setItem(key(api), identity.playerId);
    else localStorage.removeItem(key(api));
  } catch {
    /* No stored member association: guest-only offline access. */
  }
  notify();
}
export function clearOfflineIdentity(api: string | undefined) {
  try {
    localStorage.removeItem(key(api));
  } catch {
    /* Reads also fail closed. */
  }
  notify();
}
const subscribe = (listener: () => void) => {
  window.addEventListener("storage", listener);
  window.addEventListener("offline-owner-changed", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("offline-owner-changed", listener);
  };
};
export function useOfflineScope() {
  const account = useAccount();
  const online = useOnline();
  const remembered = useSyncExternalStore(subscribe, () => {
    try {
      return localStorage.getItem(key(account.apiUrl));
    } catch {
      return null;
    }
  });
  const member = online
    ? !account.loading &&
      !account.error &&
      account.identity.kind === "member" &&
      remembered === account.identity.playerId
      ? account.identity.playerId
      : null
    : remembered;
  const scope =
    online && account.apiUrl && (account.loading || account.error)
      ? null
      : `${account.apiUrl ?? "local"}|${member ?? "guest"}`;
  return {
    scope,
    member,
    online,
    apiUrl: account.apiUrl,
    refreshToken: account.refreshToken,
    identityError: account.error,
  };
}
