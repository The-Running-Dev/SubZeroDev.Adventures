import { createContext, useContext, useLayoutEffect } from "react";

export interface PlayerShellState {
  hidden?: boolean;
  title?: string;
  onSelectShelf?: () => void;
}

export const PlayerShellContext = createContext<
  (value: PlayerShellState | null) => void
>(() => {});

/** Gameplay reports presentation; the long-lived shell owns the actual chrome. */
export function usePlayerShell({
  hidden,
  title,
  onSelectShelf,
}: PlayerShellState) {
  const setState = useContext(PlayerShellContext);
  useLayoutEffect(() => {
    setState({ hidden, title, onSelectShelf });
    return () => setState(null);
  }, [setState, hidden, title, onSelectShelf]);
}
