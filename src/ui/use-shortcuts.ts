import { useEffect, useRef } from "react";

const isPaletteKey = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";

// ⌘K (or Ctrl+K) and Escape, from anywhere. The handlers are always the latest render's.
export function useShortcuts(onPalette: () => void, onEscape: () => void) {
  const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  keys.current = (event) => {
    if (isPaletteKey(event)) {
      event.preventDefault();
      onPalette();
    } else if (event.key === "Escape") onEscape();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keys.current(event);
    addEventListener("keydown", onKey);

    return () => removeEventListener("keydown", onKey);
  }, []);
}
