import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { imageSrc, type PendingImage } from "./pick-images";

// Enter sends on a keyboard; on touch Enter is a newline and the button sends.
const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const imageFiles = (files: FileList | null | undefined) =>
  [...(files ?? [])].filter((file) => file.type.startsWith("image/"));

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
  images = [],
  onAddImages,
  onRemoveImage,
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
  /** Images to send with the message; with onAddImages, the composer offers to attach them. */
  images?: readonly PendingImage[];
  onAddImages?: (files: File[]) => void;
  onRemoveImage?: (id: string) => void;
  children?: ReactNode;
  label: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  const empty = value.trim() === "" && images.length === 0;
  const stop = working && empty && onStop !== undefined;
  const attach = onAddImages !== undefined && !disabled;
  return (
    <form
      className="composer"
      data-dragging={dragging}
      onSubmit={(event) => {
        event.preventDefault();
        if (stop) onStop();
        else if (!empty && !busy && !disabled) onSubmit();
      }}
      onDragOver={(event) => {
        if (!attach || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        const to = event.relatedTarget;
        if (!(to instanceof Node) || !event.currentTarget.contains(to)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        const files = imageFiles(event.dataTransfer.files);
        if (!attach || files.length === 0) return;
        event.preventDefault();
        onAddImages(files);
      }}
    >
      {images.length > 0 ? (
        <ul className="composer-images" aria-label="Images to send">
          {images.map((image) => (
            <li key={image.id}>
              <img src={imageSrc(image)} alt={image.name} />
              <button
                type="button"
                className="composer-image-remove"
                aria-label={`Remove ${image.name}`}
                onClick={() => onRemoveImage?.(image.id)}
              >
                <Icon name="x" size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {onAddImages ? (
        <>
          <button
            type="button"
            className="attach-button pressable"
            aria-label="Attach images"
            disabled={disabled}
            onClick={() => picker.current?.click()}
          >
            <Icon name="image" size={17} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              const files = imageFiles(event.target.files);
              event.target.value = "";
              if (files.length > 0) onAddImages(files);
            }}
          />
        </>
      ) : null}
      <textarea
        ref={area}
        rows={1}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => {
          const files = imageFiles(event.clipboardData.files);
          if (!attach || files.length === 0) return;
          event.preventDefault();
          onAddImages(files);
        }}
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
