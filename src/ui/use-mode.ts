import { useEffect, useState } from "react";

/** The light or dark mode use-theme sets on <html>. */
export function useMode(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.mode === "dark" ? "dark" : "light");
  const [mode, setMode] = useState(read);

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });

    return () => observer.disconnect();
  }, []);

  return mode;
}
