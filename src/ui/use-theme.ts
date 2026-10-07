import { useEffect, useState } from "react";
import type { Theme } from "./Panel";

/** The page background per theme, for the browser and home-screen chrome. */
const CHROME: Record<Theme, string> = { light: "#ffffff", dark: "#111111" };

// Light or dark, remembered in localStorage and set on <html> for the CSS.
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem("theme") === "dark" ? "dark" : "light"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", theme);
    document.documentElement.style.colorScheme = theme;
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", CHROME[theme]);
    localStorage.setItem("theme", theme);
  }, [theme]);

  return [theme, setTheme];
}
