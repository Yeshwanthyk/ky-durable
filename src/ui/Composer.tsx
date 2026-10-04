import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { imageSrc, type PendingImage } from "./pick-images";

// Enter sends on a keyboard; on touch Enter is a newline and the button sends.
const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

// Taller than one line and its padding means the text wrapped; the line grows with Settings → Text size.
function oneLine(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const line = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

  return Math.max(parseFloat(style.minHeight), line) + 2;
}

let ruler: CanvasRenderingContext2D | null = null;

// Whether the text fits on one line of a textarea this wide, padding and a little slack included.
function fitsOneLine(element: HTMLTextAreaElement, text: string, width: number): boolean {
  ruler ??= document.createElement("canvas").getContext("2d");
  if (ruler === null) return text === "";
  const style = getComputedStyle(element);
  ruler.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const room = width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 8;

  return ruler.measureText(text).width < room;
}

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
  // A pill while it is one line; once the text wraps it opens into a card with the buttons
  // below. It closes again only when the text would fit the pill's narrower line, measured
  // against the width the pill had, so it never flips back and forth at the edge.
  const [open, setOpen] = useState(false);
  const pillWidth = useRef(0);
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    if (!open) {
      pillWidth.current = element.clientWidth;
      if (value.includes("\n") || element.scrollHeight > oneLine(element)) setOpen(true);
    } else if (!value.includes("\n") && fitsOneLine(element, value, pillWidth.current)) setOpen(false);
  }, [value, open]);
  const empty = value.trim() === "" && images.length === 0;
  const stop = working && empty && onStop !== undefined;
  const attach = onAddImages !== undefined && !disabled;
  return (
    <form
      className="composer"
      data-dragging={dragging}
      data-open={open}
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
