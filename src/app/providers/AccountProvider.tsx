import { useQueryClient } from "@tanstack/react-query";
import { useApiUrl } from "./ApiProvider";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  consumeAuthError,
  useAdminAccess,
  useIdentity,
} from "../../play/identity";

function useAccountState(apiUrl: string | undefined) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const identity = useIdentity(apiUrl, refreshToken);
  const client = useQueryClient();
  const admin = useAdminAccess(
    apiUrl,
    identity.identity.playerId,
    refreshToken,
  );
  useLayoutEffect(() => {
    const stale = {
      predicate: (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] === "private" &&
        (query.queryKey[1] !== apiUrl ||
          query.queryKey[2] !== identity.identity.playerId ||
          query.queryKey[3] !== refreshToken),
    };
    void client.cancelQueries(stale);
    client.removeQueries(stale);
  }, [client, apiUrl, identity.identity.playerId, refreshToken]);
  const [authError] = useState(consumeAuthError);
  return {
    apiUrl,
    ...identity,
    isAdmin: admin.isAdmin,
    adminAccessLoading: admin.loading,
    authError,
    refreshToken,
    sessionGeneration,
    refreshIdentity: (preserveRun = false) => {
      if (!preserveRun) setSessionGeneration((value) => value + 1);
      void client.cancelQueries({ queryKey: ["private"] });
      client.removeQueries({ queryKey: ["private"] });
      client.removeQueries({ queryKey: ["identity"] });
      setRefreshToken((token) => token + 1);
    },
  };
}

const AccountContext = createContext<ReturnType<typeof useAccountState> | null>(
  null,
);

export function AccountProvider({ children }: { children: ReactNode }) {
  const value = useAccountState(useApiUrl());
  return (
    <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
  );
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider is required");
  return value;
}
