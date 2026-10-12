import { useState } from "react";
import { Icon } from "./Icon";

/** A copy icon that copies `text`, then shows a check for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });

  return (
    <button type="button" className="icon-button pressable" aria-label={copied ? "Copied" : label} onClick={copy}>
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

/** A command or code to copy whole: the text, and a copy icon beside it. */
export function CopyLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="copy-line">
      <code className="machine-command" aria-label={label}>
        {text}
      </code>
      <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}
