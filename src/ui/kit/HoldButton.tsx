import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ButtonSize } from "./Button";

/** How long a hold takes; kit.css's --kit-hold says the same, so the fill ends as onConfirm fires. */
const HOLD_MS = 1200;

/** The keys that hold the button from the keyboard, as a press does. */
const HOLD_KEYS = new Set(["Enter", " "]);

/**
 * A button that acts only once held for 1.2s: red fills across it while held, and letting go early snaps it back. A
 * pointer or Enter/Space holds it; a key's repeat doesn't restart it.
 */
export function HoldButton({ children, onConfirm, label, size = 32, disabled }: { children: ReactNode; onConfirm: () => void; label?: string; size?: ButtonSize; disabled?: boolean }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const release = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setHeld(false);
  };

  const press = () => {
    if (disabled || timer.current !== undefined) return;
    setHeld(true);
    timer.current = setTimeout(() => {
      release();
      onConfirm();
    }, HOLD_MS);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className="kit-button kit-hold"
      data-variant="secondary"
      data-size={size}
      data-held={held || undefined}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        press();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onBlur={release}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (!HOLD_KEYS.has(event.key)) return;
        event.preventDefault();

        if (!event.repeat) press();
      }}
      onKeyUp={(event) => {
        if (HOLD_KEYS.has(event.key)) release();
      }}
    >
      {children}
      <span className="kit-hold-fill" aria-hidden="true">
        {children}
      </span>
    </button>
  );
}
