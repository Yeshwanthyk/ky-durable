import { useEffect, useState } from "react";
import type { Theme } from "./Panel";

// Light or dark, remembered in localStorage and set on <html> for the CSS.
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("theme") === "dark" ? "dark" : "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", theme);
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  return [theme, setTheme];
}
