import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  applyTheme,
  readStoredTheme,
  storeTheme,
  type ThemeId,
} from "../../theme";

const ThemeContext = createContext<{
  theme: ThemeId;
  changeTheme: (theme: ThemeId) => void;
} | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(readStoredTheme);
  useEffect(() => applyTheme(theme), [theme]);
  function changeTheme(next: ThemeId) {
    setTheme(next);
    storeTheme(next);
  }
  return (
    <ThemeContext.Provider value={{ theme, changeTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is required");
  return value;
}
