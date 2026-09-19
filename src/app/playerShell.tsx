import { createContext, useContext, useLayoutEffect } from "react";

export interface PlayerShellState {
  active?: boolean;
  hidden?: boolean;
  title?: string;
  onSelectShelf?: () => void;
}

export const PlayerShellContext = createContext<
  (value: PlayerShellState | null) => void
>(() => {});

/** Gameplay reports presentation; the long-lived shell owns the actual chrome. */
export function usePlayerShell({
  active = true,
  hidden,
  title,
  onSelectShelf,
}: PlayerShellState) {
  const setState = useContext(PlayerShellContext);
  useLayoutEffect(() => {
    setState(active ? { hidden, title, onSelectShelf } : null);
    return () => setState(null);
  }, [setState, active, hidden, title, onSelectShelf]);
}
