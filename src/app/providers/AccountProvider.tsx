import { createContext, useContext, useState, type ReactNode } from "react";
import {
  consumeAuthError,
  useAdminAccess,
  useIdentity,
} from "../../play/identity";

function useAccountState(apiUrl: string | undefined) {
  const [refreshToken, setRefreshToken] = useState(0);
  const identity = useIdentity(apiUrl, refreshToken);
  const admin = useAdminAccess(apiUrl, identity.identity.playerId);
  const [authError] = useState(consumeAuthError);
  return {
    apiUrl,
    ...identity,
    isAdmin: admin.isAdmin,
    adminAccessLoading: admin.loading,
    authError,
    refreshToken,
    refreshIdentity: () => setRefreshToken((token) => token + 1),
  };
}

const AccountContext = createContext<ReturnType<typeof useAccountState> | null>(
  null,
);

export function AccountProvider({
  apiUrl,
  children,
}: {
  apiUrl?: string;
  children: ReactNode;
}) {
  const value = useAccountState(apiUrl);
  return (
    <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
  );
}

export function useAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider is required");
  return value;
}
