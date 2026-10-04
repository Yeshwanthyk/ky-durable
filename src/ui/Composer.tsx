import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

// Enter sends on a keyboard; on touch Enter is a newline and the button sends.
const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder,
  disabled = false,
  busy = false,
  working = false,
  autoFocus = false,
  children,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  working?: boolean;
  autoFocus?: boolean;
  children?: ReactNode;
  label: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  const empty = value.trim() === "";
  const stop = working && empty && onStop !== undefined;
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (stop) onStop();
        else if (!empty && !busy && !disabled) onSubmit();
      }}
    >
      <textarea
        ref={area}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          const send = event.metaKey || event.ctrlKey || (!event.shiftKey && !coarse());
          if (!send) return;
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="composer-bar">
        {children}
        <span className="hint desktop-only">{working ? "Enter to steer" : "Enter to send"}</span>
        <button
          type="submit"
          className="send-button pressable"
          data-mode={stop ? "stop" : "send"}
          aria-label={stop ? "Stop" : "Send"}
          disabled={disabled || busy || (empty && !stop)}
        >
          <Icon name={stop ? "stop" : "arrowUp"} size={stop ? 12 : 15} />
        </button>
      </div>
    </form>
  );
}
