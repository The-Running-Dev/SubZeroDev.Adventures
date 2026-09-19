import { createContext, useContext, type ReactNode } from "react";
const ApiContext = createContext<string | undefined>(undefined);
export function ApiProvider({
  url,
  children,
}: {
  url?: string;
  children: ReactNode;
}) {
  return (
    <ApiContext.Provider value={url || undefined}>
      {children}
    </ApiContext.Provider>
  );
}
export function useApiUrl() {
  return useContext(ApiContext);
}
